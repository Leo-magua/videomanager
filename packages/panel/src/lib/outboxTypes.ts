// Outbox 操作类型（客户端）。与 packages/shared/protocol.ts 的 OutboxOp/OutboxEntry 对齐。
import type { ActorEntry } from '@/types'

export type OutboxOp =
  | { kind: 'media.rename'; mediaId: string; payload: { name: string } }
  | { kind: 'media.setRating'; mediaId: string; payload: { rating: number } }
  | { kind: 'media.setTags'; mediaId: string; payload: { tags: string[] } }
  | { kind: 'media.setCast'; mediaId: string; payload: { cast: string[] } }
  | { kind: 'mark.add'; mediaId: string; payload: { time: number; label?: string; note?: string } }
  | { kind: 'mark.update'; mediaId: string; markId: string; payload: Record<string, unknown> }
  | { kind: 'mark.remove'; mediaId: string; markId: string }
  | { kind: 'clip.create'; payload: { parentId: string; rangeStart: number; rangeEnd: number; name: string } }
  | { kind: 'actor.upsert'; payload: ActorEntry }

export interface OutboxEntry {
  opId: string
  seq: number
  op: OutboxOp
  createdAt: number
}

export interface FlushResponse {
  ackedOpIds: string[]
  rejected: Array<{ opId: string; reason: string }>
  delta: unknown
}
