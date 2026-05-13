import WorkspaceSidebar from './WorkspaceSidebar';

type Rpc = <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;

interface FileExplorerProps {
  root: string;
  rpc: Rpc;
  onOpenFile: (path: string, readOnly: boolean) => void;
}

export default function FileExplorer({ root, rpc, onOpenFile }: FileExplorerProps) {
  return <WorkspaceSidebar root={root} rpc={rpc} onOpenFile={onOpenFile} initialPanel="files" />;
}
