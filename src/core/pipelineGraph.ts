import * as fs from 'fs';
import * as path from 'path';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';

const WorkflowState = Annotation.Root({
  runId: Annotation<string>,
  status: Annotation<'started' | 'completed' | 'failed'>,
  outDir: Annotation<string>,
  error: Annotation<string>,
});

export interface PipelineGraphResult { outDir: string; }

/**
 * Durable LangGraph entrypoint around the production pipeline. The checkpoint
 * contains only lifecycle metadata (never prompts, source code, credentials or
 * model output); detailed, resumable stage state remains in the existing
 * per-run state.json and cache files.
 */
export async function invokePipelineGraph(args: {
  runId: string;
  checkpointPath: string;
  execute: () => Promise<PipelineGraphResult>;
}): Promise<PipelineGraphResult> {
  const persist = (state: Record<string, unknown>) => {
    fs.mkdirSync(path.dirname(args.checkpointPath), { recursive: true });
    const temp = `${args.checkpointPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), ...state }, null, 2));
    fs.renameSync(temp, args.checkpointPath);
  };
  persist({ runId: args.runId, status: 'started' });
  const graph = new StateGraph(WorkflowState)
    .addNode('pipeline', async () => {
      try {
        const result = await args.execute();
        persist({ runId: args.runId, status: 'completed', outDir: result.outDir });
        return { status: 'completed' as const, outDir: result.outDir, error: '' };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        persist({ runId: args.runId, status: 'failed', error });
        return { status: 'failed' as const, outDir: '', error };
      }
    })
    .addEdge(START, 'pipeline')
    .addEdge('pipeline', END)
    .compile();
  const state = await graph.invoke({ runId: args.runId, status: 'started', outDir: '', error: '' });
  if (state.status !== 'completed') throw new Error(state.error || 'LangGraph 管线未完成');
  return { outDir: state.outDir };
}
