/**
 * The board launcher: one button in the conversation input dock that opens
 * the board tab through the Sidebar's navigation face.
 * @module dsh-repo-board/client
 */

interface LauncherProps {
  readonly open: () => void
}

const dockButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '3px 10px',
  borderRadius: 999,
  border: '1px solid #0f766e',
  color: '#0f766e',
  background: 'transparent',
  cursor: 'pointer',
  fontSize: 12,
}

export function BoardLauncherButton({ open }: LauncherProps): React.ReactElement {
  return (
    <button style={dockButtonStyle} onClick={open} title="打开多仓看板（RepoGraph 关系编辑器）">
      ⬡ 多仓看板
    </button>
  )
}
