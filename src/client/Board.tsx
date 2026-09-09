/**
 * The multi-repo board panel - the graphical RepoGraph editor
 * (docs/product-design.md 7, 7.1).
 *
 * Renders the graph the host serves at /repo-board/graph.json as an SVG:
 * columns by topological depth (upstream left), contract edges in amber with
 * their token, cycle members grouped. All editing verbs post back to the
 * host: draw manual edges, confirm candidates, suppress noise, remove
 * mistakes - the human half of the merge strategy. The requirement strip
 * shows the dispatch pipeline state per requirement. Pure inline styles:
 * the client bundle ships no stylesheets.
 * @module dsh-repo-board/client
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RepoGraphDocument } from '../graph/types.ts'
import type { RepoEdgeType } from '../graph/types.ts'
import { defaultMetrics, edgeColor, edgePath, layoutBoard, nodeAccent } from './viewmodel.ts'
import type { EdgeLayout, NodeLayout } from './viewmodel.ts'

interface RequirementSummary {
  readonly id: string
  readonly status: string
  readonly text: string
}

interface BoardProps {
  /** Base URL of the host routes; defaults to same-origin. */
  readonly baseUrl?: string
}

interface EdgeActionRequest {
  readonly action: 'add-manual-edge' | 'confirm' | 'suppress' | 'remove'
  readonly id?: string
  readonly from?: string
  readonly to?: string
  readonly type?: RepoEdgeType
  readonly contractKind?: string
  readonly contractName?: string
  readonly reason?: string
}

async function postEdgeAction(baseUrl: string, request: EdgeActionRequest): Promise<void> {
  const response = await fetch(baseUrl + '/repo-board/edges', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error('编辑失败（' + response.status + '）：' + text)
  }
}

const EDGE_TYPES: readonly RepoEdgeType[] = ['build', 'code', 'contract', 'semantic']

const panelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  overflow: 'hidden',
  fontFamily: 'system-ui, sans-serif',
  fontSize: 13,
  color: '#111827',
  background: '#f9fafb',
}

const svgWrapStyle: React.CSSProperties = { flex: 1, overflow: 'auto', padding: 8 }

const sideStyle: React.CSSProperties = {
  width: 260,
  borderLeft: '1px solid #e5e7eb',
  padding: 12,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  background: '#ffffff',
}

const buttonStyle: React.CSSProperties = {
  padding: '4px 10px',
  borderRadius: 6,
  border: '1px solid #d1d5db',
  background: '#ffffff',
  cursor: 'pointer',
}

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: '#0f766e',
  borderColor: '#0f766e',
  color: '#ffffff',
}

const smallLabelStyle: React.CSSProperties = { color: '#6b7280', fontSize: 11, textTransform: 'uppercase' }

export function BoardPanel({ baseUrl = '' }: BoardProps): React.ReactElement {
  const [document, setDocument] = useState<RepoGraphDocument | null>(null)
  const [requirements, setRequirements] = useState<readonly RequirementSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selectedNode, setSelectedNode] = useState<NodeLayout | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<EdgeLayout | null>(null)
  const [linkMode, setLinkMode] = useState(false)
  const [linkFrom, setLinkFrom] = useState<string | null>(null)
  const [linkTo, setLinkTo] = useState<string | null>(null)
  const [linkType, setLinkType] = useState<RepoEdgeType>('semantic')
  const [linkContract, setLinkContract] = useState('')

  const reload = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const [graphResponse, requirementsResponse] = await Promise.all([
        fetch(baseUrl + '/repo-board/graph.json'),
        fetch(baseUrl + '/repo-board/requirements.json'),
      ])
      if (!graphResponse.ok) throw new Error('图数据不可用（' + graphResponse.status + '）— 先在会话里执行 repo_board_scan')
      setDocument((await graphResponse.json()) as RepoGraphDocument)
      setRequirements(requirementsResponse.ok ? ((await requirementsResponse.json()) as RequirementSummary[]) : [])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [baseUrl])

  useEffect(() => { void reload() }, [reload])

  const layout = useMemo(() => (document === null ? null : layoutBoard(document)), [document])

  const runAction = useCallback(async (request: EdgeActionRequest) => {
    setBusy(true)
    setError(null)
    try {
      await postEdgeAction(baseUrl, request)
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [baseUrl, reload])

  const onNodeClick = (node: NodeLayout): void => {
    setSelectedEdge(null)
    if (linkMode) {
      if (linkFrom === null || linkFrom === node.repo) {
        setLinkFrom(node.repo)
        setLinkTo(null)
        return
      }
      setLinkTo(node.repo)
      return
    }
    setSelectedNode(node)
  }

  const cancelLink = (): void => {
    setLinkMode(false)
    setLinkFrom(null)
    setLinkTo(null)
    setLinkContract('')
  }

  const confirmLink = async (): Promise<void> => {
    if (linkFrom === null || linkTo === null) return
    await runAction({
      action: 'add-manual-edge',
      from: linkFrom,
      to: linkTo,
      type: linkType,
      contractKind: linkType === 'contract' ? 'other' : undefined,
      contractName: linkType === 'contract' && linkContract !== '' ? linkContract : undefined,
    })
    cancelLink()
  }

  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid #e5e7eb' }}>
        <strong>多仓看板</strong>
        <span style={{ ...smallLabelStyle, textTransform: 'none' }}>
          {document === null ? '' : document.project + ' · ' + Object.keys(document.nodes).length + ' 仓 · ' + document.edges.length + ' 边'}
        </span>
        <div style={{ flex: 1 }} />
        {!linkMode
          ? (
            <button style={primaryButtonStyle} disabled={busy || document === null} onClick={() => { setSelectedNode(null); setSelectedEdge(null); setLinkMode(true) }}>
              手动连边
            </button>
          )
          : (
            <button style={buttonStyle} onClick={cancelLink}>取消连边</button>
          )}
        <button style={buttonStyle} disabled={busy} onClick={() => { void reload() }}>刷新</button>
      </div>

      {error !== null && (
        <div style={{ padding: '6px 12px', background: '#fef2f2', color: '#b91c1c', borderBottom: '1px solid #fecaca' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={svgWrapStyle}>
          {layout === null
            ? <p style={{ color: '#6b7280' }}>{busy ? '加载中…' : '暂无图数据'}</p>
            : (
              <svg width={layout.width} height={layout.height} role="img" aria-label="多仓关系图">
                {layout.edges.map(edge => (
                  <g key={edge.id}>
                    <path
                      d={edgePath(edge)}
                      fill="none"
                      stroke={edgeColor(edge.type, edge.status)}
                      strokeWidth={edge.status === 'confirmed' || edge.source === 'manual' ? 2.4 : 1.6}
                      strokeDasharray={edge.status === 'candidate' ? '6 3' : undefined}
                      opacity={edge.status === 'suppressed' ? 0.35 : 1}
                    />
                    <circle
                      cx={edge.mx}
                      cy={edge.my}
                      r={9}
                      fill="transparent"
                      style={{ cursor: 'pointer' }}
                      data-edge-id={edge.id}
                      onClick={() => { setSelectedEdge(edge); setSelectedNode(null) }}
                    />
                    <circle cx={edge.mx} cy={edge.my} r={3} fill={edgeColor(edge.type, edge.status)} opacity={0.8} pointerEvents="none" />
                    {edge.contract !== undefined && (
                      <text x={edge.mx} y={edge.my - 8} textAnchor="middle" fontSize={10} fill="#92400e" pointerEvents="none">
                        {edge.contract}
                      </text>
                    )}
                  </g>
                ))}
                {layout.nodes.map(node => (
                  <g
                    key={node.repo}
                    transform={'translate(' + node.x + ',' + node.y + ')'}
                    style={{ cursor: 'pointer' }}
                    data-node-id={node.repo}
                    onClick={() => onNodeClick(node)}
                  >
                    <rect
                      width={defaultMetrics.nodeWidth}
                      height={defaultMetrics.nodeHeight}
                      rx={10}
                      fill="#ffffff"
                      stroke={nodeAccent(node)}
                      strokeWidth={selectedNode?.repo === node.repo || linkFrom === node.repo ? 2.6 : 1.4}
                    />
                    <text x={12} y={22} fontSize={13} fontWeight={600} fill="#111827">
                      {document?.nodes[node.repo]?.name ?? node.repo}
                    </text>
                    <text x={12} y={40} fontSize={10} fill="#6b7280">
                      {'深度 ' + node.depth + (node.cyclePeers.length > 0 ? ' · 契约环: ' + node.cyclePeers.join(', ') : '')}
                    </text>
                  </g>
                ))}
              </svg>
            )}
        </div>

        <div style={sideStyle}>
          {linkMode && (
            <div style={{ border: '1px solid #0f766e', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontWeight: 600 }}>手动连边</div>
              {linkFrom === null
                ? <div style={smallLabelStyle}>点击一个节点作为起点</div>
                : <div style={{ fontSize: 12 }}>起点 <b>{linkFrom}</b>{linkTo === null ? ' → 点击目标节点' : ' → 目标 ' + linkTo}</div>}
              {linkFrom !== null && linkTo !== null && (
                <>
                  <select value={linkType} onChange={event => setLinkType(event.currentTarget.value as RepoEdgeType)} style={buttonStyle}>
                    {EDGE_TYPES.map(type => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                  {linkType === 'contract' && (
                    <input
                      placeholder="契约名（可选，如 order.cancelled）"
                      value={linkContract}
                      onChange={event => setLinkContract(event.currentTarget.value)}
                      style={buttonStyle}
                    />
                  )}
                  <button style={primaryButtonStyle} disabled={busy} onClick={() => { void confirmLink() }}>添加边（起点 → 目标）</button>
                </>
              )}
            </div>
          )}

          {selectedNode !== null && document !== null && (
            <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontWeight: 600 }}>{selectedNode.repo}</div>
              <div style={{ fontSize: 12 }}>名称：{document.nodes[selectedNode.repo]?.name}</div>
              {document.nodes[selectedNode.repo]?.path !== undefined && (
                <div style={{ fontSize: 12, wordBreak: 'break-all' }}>路径：{document.nodes[selectedNode.repo]?.path}</div>
              )}
              <div style={{ fontSize: 12 }}>
                出边 {document.edges.filter(edge => edge.from === selectedNode.repo).length} · 入边 {document.edges.filter(edge => edge.to === selectedNode.repo).length}
              </div>
            </div>
          )}

          {selectedEdge !== null && (
            <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontWeight: 600 }}>{selectedEdge.from} → {selectedEdge.to}</div>
              <div style={{ fontSize: 12 }}>类型 {selectedEdge.type}{selectedEdge.contract !== undefined ? ' · ' + selectedEdge.contract : ''}</div>
              <div style={{ fontSize: 12 }}>来源 {selectedEdge.source} · 状态 {selectedEdge.status}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {selectedEdge.status !== 'confirmed' && (
                  <button style={primaryButtonStyle} disabled={busy} onClick={() => { void runAction({ action: 'confirm', id: selectedEdge.id }) }}>确认</button>
                )}
                {selectedEdge.status !== 'suppressed' && (
                  <button style={buttonStyle} disabled={busy} onClick={() => { void runAction({ action: 'suppress', id: selectedEdge.id, reason: 'board UI 手动抑制' }) }}>抑制</button>
                )}
                <button style={buttonStyle} disabled={busy} onClick={() => { void runAction({ action: 'remove', id: selectedEdge.id }) }}>删除</button>
              </div>
            </div>
          )}

          <div>
            <div style={smallLabelStyle}>需求管道</div>
            {requirements.length === 0
              ? <div style={{ fontSize: 12, color: '#6b7280' }}>暂无需求记录</div>
              : requirements.map(requirement => (
                <div key={requirement.id} style={{ padding: '4px 0', borderBottom: '1px dashed #e5e7eb' }}>
                  <b>{requirement.id}</b> <span style={{ color: '#0f766e' }}>{requirement.status}</span>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>{requirement.text.slice(0, 60)}</div>
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  )
}
