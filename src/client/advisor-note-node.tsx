/**
 * Advisor note message row (fork addition) — first-class chat row for a
 * delivered advice note.
 *
 * DSH stores advisor notes as `user/message` events with
 * `source.kind: 'advisor'`. The shipped chat classifier folds every
 * non-`user` source into a Context node, and `isVisibleChatNode` hides all
 * ordinary Context rows — which is why the notes were only visible in the
 * trajectory viewer. This follows the same pattern the TTSR plugin uses for
 * its reminders: register an EXCLUSIVE conversation Event definition that
 * claims the advisor-source events (so the hidden context fold never builds)
 * and publish a visible node with our own kind, then render that kind in the
 * keyed `conversation.chat.node` slot. The note then appears as a normal row
 * in the chat list, in place.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import type { AdvisorKey } from './locales.ts'
import { en } from './locales.ts'
import styles from './advisor-note-node.module.css'

/** Our chat node kind (a plugin-owned key in `conversation.chat.node`). */
export const ADVISOR_NOTE_NODE_KIND = 'dsh-advisor:note'

/** The message source kind the host uses for delivered notes. */
const ADVISOR_SOURCE_KIND = 'advisor'

/** The severity vocabulary the runtime emits. */
type NoteSeverity = 'nit' | 'concern' | 'blocker'

/** Business data carried by one advisor note node. */
interface AdvisorNoteData {
  readonly text: string
  readonly severity: NoteSeverity
  readonly at: number
}

/**
 * Parse an advisor `user/message` event into node data, or null when the
 * event is not one (the same predicate backs both `match` and `start`).
 */
function parseAdvisorNote(event: {
  type?: string
  surfaceOp?: string
  seq?: number
  time?: number
  data?: {
    id?: string
    content?: readonly { type?: string; text?: string }[]
    source?: { kind?: string }
  }
}): AdvisorNoteData | null {
  if (event.type !== 'user/message') return null
  if (event.surfaceOp !== 'append') return null
  const message = event.data
  if (message?.source?.kind !== ADVISOR_SOURCE_KIND) return null
  const text = (message.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
  const match = /^\[advisor:(nit|concern|blocker)\]\s*([\s\S]*)$/.exec(text)
  if (match === null || match[2].trim().length === 0) return null
  return {
    text: match[2].trim(),
    severity: match[1] as NoteSeverity,
    at: typeof event.time === 'number' ? event.time : Date.now(),
  }
}

/** Props the chat node renderer binds for one node. */
export interface AdvisorNoteRowProps {
  readonly node?: { readonly id?: string; readonly data?: AdvisorNoteData }
  readonly t?: (key: AdvisorKey) => string
}

/**
 * Render one advisor note as a chat message row: a severity dot + label and
 * the note text, in place in the conversation flow.
 * @param props - the chat node renderer props (node data + locale seat).
 * @returns the row, or null for a node without data.
 */
export function AdvisorNoteRow(props: AdvisorNoteRowProps): ReactNode {
  const data = props.node?.data
  if (data === undefined) return null
  const t = props.t ?? ((key: AdvisorKey) => en[key])
  return (
    <section className={styles['row']} data-advisor-note="">
      <span className={`${styles['dot']} ${styles[data.severity]}`} aria-hidden="true" />
      <span className={styles['label']}>{t('notesTitle')}</span>
      <span className={styles['severity']}>{data.severity}</span>
      <span className={styles['text']}>{data.text}</span>
    </section>
  )
}

/**
 * Register the advisor-note Event definition and its chat-row renderer.
 * Defensive: a composition without `uiConversation` (test harnesses, headless
 * clients) keeps working — the registration is simply skipped.
 * @param ctx - the client root context.
 */
export function installAdvisorNoteNode(ctx: ClientContext): void {
  const conversation = (ctx as unknown as {
    uiConversation?: {
      events: { register(definition: unknown): () => void }
    }
  }).uiConversation
  if (conversation === undefined) return

  ctx.effect(() => conversation.events.register({
    kind: ADVISOR_NOTE_NODE_KIND,
    target: 'chat',
    match: (event: never) => {
      const note = parseAdvisorNote(event as never)
      if (note === null) return null
      const message = (event as unknown as { seq?: number; data?: { id?: string } }).data
      return {
        id: String(message?.id ?? (event as unknown as { seq?: number }).seq ?? ''),
        role: 'start',
        // Claim exclusively: the default input-message fold would otherwise
        // build a hidden Context row for the same event.
        exclusive: true,
      }
    },
    start: (_context: unknown, match: { event: never }) => parseAdvisorNote(match.event as never),
    update: (context: { state: unknown }) => context.state,
    buildViewNode: (context: {
      key: string
      id: string
      state: AdvisorNoteData | null
      start?: { event: { seq: number }; location: unknown }
    }) => {
      if (context.start === undefined || context.state === null) return null
      return {
        key: context.key,
        kind: ADVISOR_NOTE_NODE_KIND,
        id: context.id,
        target: 'chat',
        anchorSeq: context.start.event.seq,
        location: context.start.location,
        visibility: 'visible',
        data: context.state,
      }
    },
  }) as never, 'advisor: note chat node')

  ctx.slots.inject('conversation.chat.node' as never, function* () {
    yield (ctx.slots as unknown as {
      register(options: unknown, component: unknown): () => void
    }).register({
      name: 'conversation.chat.node',
      key: ADVISOR_NOTE_NODE_KIND,
      locale: 'settings.advisor',
    }, AdvisorNoteRow)
  })
}