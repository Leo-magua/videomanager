export interface BatchDeleteResult {
  removed: string[]
  failures: {id: string; message: string}[]
  syncWarning?: string
}
export type DeleteProgress = (done: number, total: number) => void

/** Delete only this confirmed snapshot; retain failures and never queue offline deletes. */
export async function deleteBatch(ids: string[], remove: (id: string) => Promise<unknown>, onProgress?: DeleteProgress): Promise<BatchDeleteResult> {
  const unique = [...new Set(ids)]
  const result: BatchDeleteResult = {removed: [], failures: []}
  onProgress?.(0, unique.length)
  for (const [index, id] of unique.entries()) {
    let disconnected = false
    try {
      await remove(id)
      result.removed.push(id)
    } catch (error) {
      // Retrying a lost response, or deleting overlapping storage aliases, may
      // encounter an already-removed record. The requested final state is met.
      if (error instanceof Error && 'status' in error && error.status === 404) result.removed.push(id)
      else {
        const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        disconnected = timeout || error instanceof TypeError
        result.failures.push({id, message: timeout ? '请求超时，删除结果尚未确认，请连接后重试' : error instanceof TypeError ? '无法连接服务器，请连接后重试' : error instanceof Error ? error.message : '删除失败，请重试'})
      }
    }
    onProgress?.(index + 1, unique.length)
    if (disconnected) {
      result.failures.push(...unique.slice(index + 1).map(id => ({id, message: '尚未删除：连接中断，请连接后重试'})))
      break
    }
  }
  return result
}
