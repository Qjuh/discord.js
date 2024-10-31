import { DocNode } from './DocNode';

export async function SummaryNode({
	padding = false,
	node,
	version,
}: {
	readonly node: any;
	readonly padding?: boolean;
	readonly version: string;
}) {
	return (
		<div className={`break-words ${padding ? 'pl-4' : ''}`}>
			<DocNode node={node} version={version} />
		</div>
	);
}
