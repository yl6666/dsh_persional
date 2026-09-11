/**
 * Manifest extractor - the deterministic first stage of the three-tier
 * extraction pipeline (docs/product-design.md 4.3).
 *
 * Pure functions over file contents: no filesystem, no network. The caller
 * reads manifest files and hands them in as a path -> content record; this
 * module parses them per ecosystem and resolves declared dependencies into
 * build edges over the repo group. Production dependencies only - dev/test
 * dependencies are excluded to keep the coupling signal clean.
 * @module dsh-repo-board
 */
/** Top-level manifest files the caller should read for one repo. */
export const MANIFEST_FILES = [
    'package.json',
    'go.mod',
    'Cargo.toml',
    'pom.xml',
    'pyproject.toml',
    'requirements.txt',
    'Gemfile',
    'composer.json',
];
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseJson(repo, file, content) {
    try {
        return JSON.parse(content);
    }
    catch (error) {
        throw new TypeError('manifest ' + repo + '/' + file + ': invalid JSON (' + String(error) + ')');
    }
}
function parseNpm(repo, content, result) {
    const json = parseJson(repo, 'package.json', content);
    if (typeof json.name === 'string' && json.name !== '') {
        result.provides.push({ ecosystem: 'npm', name: json.name });
    }
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
        const map = json[field];
        if (!isRecord(map))
            continue;
        for (const [name, constraint] of Object.entries(map)) {
            result.dependsOn.push({
                ecosystem: 'npm',
                name,
                versionConstraint: typeof constraint === 'string' ? constraint : undefined,
            });
        }
    }
}
function parseGoMod(content, result) {
    const module = /^module\s+(\S+)/m.exec(content)?.[1];
    if (module !== undefined)
        result.provides.push({ ecosystem: 'go', name: module });
    const requireLine = (name, version, rest) => {
        if (rest.includes('indirect'))
            return;
        result.dependsOn.push({ ecosystem: 'go', name, versionConstraint: version });
    };
    for (const match of content.matchAll(/^require\s+([^\s(]+)\s+([^\s(]+)(.*)$/gm)) {
        requireLine(match[1], match[2], match[3] ?? '');
    }
    for (const block of content.matchAll(/^require\s*\(([\s\S]*?)\)/gm)) {
        for (const line of block[1].split('\n')) {
            const m = /^\s*(\S+)\s+(\S+)(.*)$/.exec(line);
            if (m !== null)
                requireLine(m[1], m[2], m[3] ?? '');
        }
    }
}
function parseCargoToml(content, result) {
    let section = '';
    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        const header = /^\[([^\]]+)\]$/.exec(line);
        if (header !== null) {
            section = header[1];
            continue;
        }
        if (section === 'package') {
            const m = /^name\s*=\s*"([^"]+)"/.exec(line);
            if (m !== null)
                result.provides.push({ ecosystem: 'cargo', name: m[1] });
        }
        else if (section === 'dependencies') {
            const m = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
            if (m === null)
                continue;
            const rest = m[2];
            const version = /^"([^"]*)"/.exec(rest)?.[1] ?? /\bversion\s*=\s*"([^"]*)"/.exec(rest)?.[1];
            result.dependsOn.push({ ecosystem: 'cargo', name: m[1], versionConstraint: version });
        }
    }
}
function parsePomXml(content, result) {
    const stripped = content.replace(/<parent>[\s\S]*?<\/parent>/g, '').replace(/<build>[\s\S]*?<\/build>/g, '');
    const groupId = /<groupId>([^<]+)<\/groupId>/.exec(stripped)?.[1]?.trim();
    const artifactId = /<artifactId>([^<]+)<\/artifactId>/.exec(stripped)?.[1]?.trim();
    if (groupId !== undefined && artifactId !== undefined) {
        result.provides.push({ ecosystem: 'maven', name: groupId + ':' + artifactId });
    }
    for (const match of content.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
        const block = match[1];
        const g = /<groupId>([^<]+)<\/groupId>/.exec(block)?.[1]?.trim();
        const a = /<artifactId>([^<]+)<\/artifactId>/.exec(block)?.[1]?.trim();
        const v = /<version>([^<]+)<\/version>/.exec(block)?.[1]?.trim();
        const scope = /<scope>([^<]+)<\/scope>/.exec(block)?.[1]?.trim();
        if (g === undefined || a === undefined)
            continue;
        if (scope === 'test' || scope === 'provided')
            continue;
        result.dependsOn.push({ ecosystem: 'maven', name: g + ':' + a, versionConstraint: v });
    }
}
function parsePep508(spec) {
    const beforeComment = spec.split(';')[0].trim();
    const name = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(beforeComment)?.[0] ?? beforeComment;
    const constraint = /(==|>=|<=|!=|~=|>|<)[\s\S]*$/.exec(beforeComment)?.[0]?.replace(/\s+/g, '');
    return { ecosystem: 'pypi', name, versionConstraint: constraint };
}
function parsePyproject(content, result) {
    let section = '';
    let inDepsArray = false;
    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        const header = /^\[([^\]]+)\]$/.exec(line);
        if (header !== null) {
            section = header[1];
            inDepsArray = false;
            continue;
        }
        if (section !== 'project')
            continue;
        if (inDepsArray) {
            if (line === ']') {
                inDepsArray = false;
                continue;
            }
            const item = /^["']([^"']+)["']/.exec(line)?.[1];
            if (item !== undefined)
                result.dependsOn.push(parsePep508(item));
            continue;
        }
        const nameMatch = /^name\s*=\s*"([^"]+)"/.exec(line);
        if (nameMatch !== null) {
            result.provides.push({ ecosystem: 'pypi', name: nameMatch[1] });
            continue;
        }
        if (/^dependencies\s*=\s*\[/.test(line)) {
            const inline = /\[(.*)\]/.exec(line)?.[1];
            if (inline !== undefined && inline.trim() !== '') {
                for (const item of inline.matchAll(/["']([^"']+)["']/g))
                    result.dependsOn.push(parsePep508(item[1]));
            }
            else {
                inDepsArray = true;
            }
        }
    }
}
function parseRequirements(content, result) {
    for (const rawLine of content.split('\n')) {
        const line = rawLine.split('#')[0].trim();
        if (line === '' || line.startsWith('-'))
            continue;
        result.dependsOn.push(parsePep508(line));
    }
}
function parseGemfile(content, result) {
    for (const match of content.matchAll(/^\s*gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/gm)) {
        result.dependsOn.push({ ecosystem: 'gem', name: match[1], versionConstraint: match[2] });
    }
}
function parseGemspec(content) {
    return /^\s*spec\.name\s*=\s*['"]([^'"]+)['"]/m.exec(content)?.[1];
}
function parseComposer(repo, content, result) {
    const json = parseJson(repo, 'composer.json', content);
    if (typeof json.name === 'string' && json.name !== '') {
        result.provides.push({ ecosystem: 'composer', name: json.name });
    }
    if (isRecord(json.require)) {
        for (const [name, constraint] of Object.entries(json.require)) {
            if (name === 'php' || name.startsWith('ext-'))
                continue;
            result.dependsOn.push({
                ecosystem: 'composer',
                name,
                versionConstraint: typeof constraint === 'string' ? constraint : undefined,
            });
        }
    }
}
/**
 * Parse one repo directory's manifests. `files` maps relative paths to
 * contents; only the known manifest files (plus `*.gemspec`) are consumed.
 * Malformed JSON manifests throw - the extractor fails loud (design 4.3).
 */
export function parseManifests(repo, files) {
    const provides = [];
    const dependsOn = [];
    const buildSystems = [];
    const result = { provides, dependsOn };
    const npmContent = files['package.json'];
    if (npmContent !== undefined) {
        buildSystems.push('npm');
        parseNpm(repo, npmContent, result);
    }
    const goContent = files['go.mod'];
    if (goContent !== undefined) {
        buildSystems.push('go');
        parseGoMod(goContent, result);
    }
    const cargoContent = files['Cargo.toml'];
    if (cargoContent !== undefined) {
        buildSystems.push('cargo');
        parseCargoToml(cargoContent, result);
    }
    const pomContent = files['pom.xml'];
    if (pomContent !== undefined) {
        buildSystems.push('maven');
        parsePomXml(pomContent, result);
    }
    const pyprojectContent = files['pyproject.toml'];
    if (pyprojectContent !== undefined) {
        buildSystems.push('pypi');
        parsePyproject(pyprojectContent, result);
    }
    const requirementsContent = files['requirements.txt'];
    if (requirementsContent !== undefined) {
        if (!buildSystems.includes('pypi'))
            buildSystems.push('pypi');
        parseRequirements(requirementsContent, result);
    }
    const gemfileContent = files['Gemfile'];
    if (gemfileContent !== undefined) {
        buildSystems.push('gem');
        parseGemfile(gemfileContent, result);
    }
    for (const [path, content] of Object.entries(files)) {
        if (!path.endsWith('.gemspec'))
            continue;
        const name = parseGemspec(content);
        if (name !== undefined && !provides.some(pkg => pkg.ecosystem === 'gem' && pkg.name === name)) {
            provides.push({ ecosystem: 'gem', name });
        }
    }
    const composerContent = files['composer.json'];
    if (composerContent !== undefined) {
        buildSystems.push('composer');
        parseComposer(repo, composerContent, result);
    }
    return { repo, provides, dependsOn, buildSystems };
}
/**
 * Resolve declared dependencies across the repo group into build edges.
 * A dependency resolves when another repo in the group provides the same
 * (ecosystem, name). Self-edges are skipped; a from-to pair deduplicates to
 * its first declaration.
 */
export function buildEdgesFromManifests(scans) {
    const providers = new Map();
    for (const scan of scans) {
        for (const pkg of scan.provides)
            providers.set(pkg.ecosystem + '::' + pkg.name, scan.repo);
    }
    const edges = new Map();
    for (const scan of scans) {
        for (const dep of scan.dependsOn) {
            const target = providers.get(dep.ecosystem + '::' + dep.name);
            if (target === undefined || target === scan.repo)
                continue;
            const key = scan.repo + '->' + target;
            if (edges.has(key))
                continue;
            edges.set(key, {
                from: scan.repo,
                to: target,
                type: 'build',
                strength: 1,
                versionConstraint: dep.versionConstraint,
            });
        }
    }
    return [...edges.values()].sort((a, b) => (a.from + '->' + a.to).localeCompare(b.from + '->' + b.to));
}
/**
 * Deterministic content fingerprint over the given files (FNV-1a, 64-bit).
 * Sorts paths so the hash is independent of directory iteration order;
 * used to skip unchanged repos during incremental rescans (design 4.4).
 */
export function contentFingerprint(files) {
    let hash = 0xcbf29ce484222325n;
    const mix = (part) => {
        for (let i = 0; i < part.length; i++) {
            hash ^= BigInt(part.charCodeAt(i));
            hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
        }
        hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    };
    for (const path of Object.keys(files).sort()) {
        mix(path);
        mix(files[path]);
    }
    return 'fnv1a64:' + hash.toString(16);
}
