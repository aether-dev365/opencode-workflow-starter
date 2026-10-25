// 同一会话的操作按到达顺序依次执行；前一个失败不阻塞后一个，队列排空后删除。
export function sessionQueue(): <T>(sessionId: string, action: () => Promise<T>) => Promise<T> {
  const queues = new Map<string, Promise<unknown>>()
  return async <T>(sessionId: string, action: () => Promise<T>): Promise<T> => {
    const next = (queues.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(action)
    queues.set(sessionId, next)
    try { return await next } finally { if (queues.get(sessionId) === next) queues.delete(sessionId) }
  }
}
