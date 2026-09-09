import { describe, expect, it } from 'vitest'
import {
  buildEdgesFromManifests,
  contentFingerprint,
  parseManifests,
} from '../src/extract/manifest.ts'

describe('parseManifests (4.3 tier one: deterministic manifests)', () => {
  it('parses npm package.json: own name plus production dependencies', () => {
    const scan = parseManifests('web', {
      'package.json': JSON.stringify({
        name: '@acme/web',
        dependencies: { '@acme/sdk': '^1.2.0', lodash: '^4.0.0' },
        devDependencies: { vitest: '^3.0.0' },
        peerDependencies: { react: '^18.0.0' },
      }),
    })
    expect(scan.buildSystems).toEqual(['npm'])
    expect(scan.provides).toEqual([{ ecosystem: 'npm', name: '@acme/web' }])
    expect(scan.dependsOn).toEqual([
      { ecosystem: 'npm', name: '@acme/sdk', versionConstraint: '^1.2.0' },
      { ecosystem: 'npm', name: 'lodash', versionConstraint: '^4.0.0' },
      { ecosystem: 'npm', name: 'react', versionConstraint: '^18.0.0' },
    ])
  })

  it('parses go.mod: module path, single-line and block requires, skips indirect', () => {
    const scan = parseManifests('go-svc', {
      'go.mod': [
        'module github.com/acme/go-svc',
        '',
        'go 1.22',
        '',
        'require github.com/acme/sdk v1.4.0',
        '',
        'require (',
        '\tgithub.com/acme/events v0.3.1',
        '\tgithub.com/external/indirect-thing v2.0.0 // indirect',
        ')',
      ].join('\n'),
    })
    expect(scan.provides).toEqual([{ ecosystem: 'go', name: 'github.com/acme/go-svc' }])
    expect(scan.dependsOn).toEqual([
      { ecosystem: 'go', name: 'github.com/acme/sdk', versionConstraint: 'v1.4.0' },
      { ecosystem: 'go', name: 'github.com/acme/events', versionConstraint: 'v0.3.1' },
    ])
  })

  it('parses Cargo.toml: package name and dependency versions', () => {
    const scan = parseManifests('rust-svc', {
      'Cargo.toml': [
        '[package]',
        'name = "acme-rust"',
        '',
        '[dependencies]',
        'acme-sdk = "2.1"',
        'serde = { version = "1.0", features = ["derive"] }',
        'workspace-pal = { workspace = true }',
      ].join('\n'),
    })
    expect(scan.provides).toEqual([{ ecosystem: 'cargo', name: 'acme-rust' }])
    expect(scan.dependsOn).toEqual([
      { ecosystem: 'cargo', name: 'acme-sdk', versionConstraint: '2.1' },
      { ecosystem: 'cargo', name: 'serde', versionConstraint: '1.0' },
      { ecosystem: 'cargo', name: 'workspace-pal' },
    ])
  })

  it('parses pom.xml: project coordinates, skipping test scope and parent', () => {
    const scan = parseManifests('java-svc', {
      'pom.xml': [
        '<project>',
        '  <parent>',
        '    <groupId>org.springframework.boot</groupId>',
        '    <artifactId>spring-boot-starter-parent</artifactId>',
        '  </parent>',
        '  <groupId>com.acme</groupId>',
        '  <artifactId>java-svc</artifactId>',
        '  <dependencies>',
        '    <dependency>',
        '      <groupId>com.acme</groupId>',
        '      <artifactId>acme-sdk</artifactId>',
        '      <version>3.2.1</version>',
        '    </dependency>',
        '    <dependency>',
        '      <groupId>junit</groupId>',
        '      <artifactId>junit</artifactId>',
        '      <scope>test</scope>',
        '    </dependency>',
        '  </dependencies>',
        '</project>',
      ].join('\n'),
    })
    expect(scan.provides).toEqual([{ ecosystem: 'maven', name: 'com.acme:java-svc' }])
    expect(scan.dependsOn).toEqual([
      { ecosystem: 'maven', name: 'com.acme:acme-sdk', versionConstraint: '3.2.1' },
    ])
  })

  it('parses pyproject.toml with a multi-line dependencies array', () => {
    const scan = parseManifests('py-svc', {
      'pyproject.toml': [
        '[project]',
        'name = "acme-py"',
        'dependencies = [',
        '  "acme-sdk>=1.0,<3",',
        '  "requests>=2.31",',
        ']',
      ].join('\n'),
    })
    expect(scan.provides).toEqual([{ ecosystem: 'pypi', name: 'acme-py' }])
    expect(scan.dependsOn).toEqual([
      { ecosystem: 'pypi', name: 'acme-sdk', versionConstraint: '>=1.0,<3' },
      { ecosystem: 'pypi', name: 'requests', versionConstraint: '>=2.31' },
    ])
  })

  it('parses requirements.txt ignoring comments, blanks, and options', () => {
    const scan = parseManifests('py-cli', {
      'requirements.txt': ['# core deps', 'acme-sdk==0.9.1', '', '-r extra.txt', 'flask ; python_version >= "3.8"'].join('\n'),
    })
    expect(scan.buildSystems).toEqual(['pypi'])
    expect(scan.dependsOn).toEqual([
      { ecosystem: 'pypi', name: 'acme-sdk', versionConstraint: '==0.9.1' },
      { ecosystem: 'pypi', name: 'flask' },
    ])
  })

  it('parses Gemfile and the matching gemspec', () => {
    const scan = parseManifests('ruby-svc', {
      Gemfile: [
        'source "https://rubygems.org"',
        "gem 'acme-sdk', '~> 2.3'",
        "gem 'rack'",
      ].join('\n'),
      'acme-ruby.gemspec': ['Gem::Specification.new do |spec|', "  spec.name = 'acme-ruby'", 'end'].join('\n'),
    })
    expect(scan.provides).toEqual([{ ecosystem: 'gem', name: 'acme-ruby' }])
    expect(scan.dependsOn).toEqual([
      { ecosystem: 'gem', name: 'acme-sdk', versionConstraint: '~> 2.3' },
      { ecosystem: 'gem', name: 'rack' },
    ])
  })

  it('parses composer.json skipping php and extension requirements', () => {
    const scan = parseManifests('php-svc', {
      'composer.json': JSON.stringify({
        name: 'acme/php-svc',
        require: { 'acme/sdk': '^4.0', php: '^8.2', 'ext-json': '*' },
      }),
    })
    expect(scan.provides).toEqual([{ ecosystem: 'composer', name: 'acme/php-svc' }])
    expect(scan.dependsOn).toEqual([{ ecosystem: 'composer', name: 'acme/sdk', versionConstraint: '^4.0' }])
  })

  it('fails loud on malformed JSON manifests', () => {
    expect(() => parseManifests('broken', { 'package.json': '{ nope' })).toThrow(TypeError)
  })
})

describe('buildEdgesFromManifests (dependency resolution)', () => {
  const scans = [
    parseManifests('web', {
      'package.json': JSON.stringify({ name: '@acme/web', dependencies: { '@acme/sdk': '^1.2.0', lodash: '^4' } }),
    }),
    parseManifests('sdk', { 'package.json': JSON.stringify({ name: '@acme/sdk' }) }),
    parseManifests('go-svc', {
      'go.mod': ['module github.com/acme/go-svc', '', 'require github.com/acme/sdk v1.4.0'].join('\n'),
    }),
    parseManifests('go-sdk', {
      'go.mod': ['module github.com/acme/sdk', '', 'go 1.22'].join('\n'),
    }),
  ]

  it('resolves cross-repo dependencies into build edges with constraints', () => {
    expect(buildEdgesFromManifests(scans)).toEqual([
      { from: 'go-svc', to: 'go-sdk', type: 'build', strength: 1, versionConstraint: 'v1.4.0' },
      { from: 'web', to: 'sdk', type: 'build', strength: 1, versionConstraint: '^1.2.0' },
    ])
  })

  it('ecosystems never cross-match: npm @acme/sdk is not go github.com/acme/sdk', () => {
    const edges = buildEdgesFromManifests(scans)
    expect(edges.some(edge => edge.from === 'go-svc' && edge.to === 'sdk')).toBe(false)
  })

  it('external dependencies that no repo provides resolve to nothing', () => {
    const edges = buildEdgesFromManifests(scans)
    expect(edges.some(edge => edge.to === 'lodash')).toBe(false)
  })

  it('self-provided names never produce self-edges', () => {
    const scan = parseManifests('solo', {
      'package.json': JSON.stringify({ name: '@acme/solo', dependencies: { '@acme/solo': '*' } }),
    })
    expect(buildEdgesFromManifests([scan])).toEqual([])
  })
})

describe('contentFingerprint (4.4 incremental rescans)', () => {
  it('is stable across key-order permutations and changes with content', () => {
    const a = contentFingerprint({ 'go.mod': 'module x', 'package.json': '{"name":"x"}' })
    const b = contentFingerprint({ 'package.json': '{"name":"x"}', 'go.mod': 'module x' })
    expect(a).toBe(b)
    expect(a).toMatch(/^fnv1a64:[0-9a-f]{16}$/)
    const c = contentFingerprint({ 'go.mod': 'module y', 'package.json': '{"name":"x"}' })
    expect(c).not.toBe(a)
  })

  it('distinguishes path sets with identical concatenated content', () => {
    const a = contentFingerprint({ 'a.toml': 'xy' })
    const b = contentFingerprint({ 'a.to': 'lxy' })
    expect(a).not.toBe(b)
  })
})
