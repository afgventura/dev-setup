/**
 * compaction-clean — remove the wrapper tags that OpenCode's summary compaction
 * leaves behind.
 *
 * OpenCode asks the compaction model for a fixed template and tells it: "Do not
 * include the <template> tags in your response." The model sometimes keeps them
 * anyway. OpenCode then checks only that the answer holds one of the template's
 * "##" headings, and stores the text verbatim — so the tags reach the timeline.
 *
 * No hook exposes the finished summary. The `compaction` hook runs before the
 * model call, and stored messages cannot be edited through the API. The response
 * hook is the one point after the model and before storage, so this plugin
 * rewrites the compaction response only.
 *
 * The response is a stream, and a provider may split a tag across chunks
 * ("<temp" then "late>"). A plain string replace would miss those. This plugin
 * parses the SSE deltas, joins their text, strips the tags, and puts the result
 * back into the first content delta. Any line it cannot parse passes through
 * unchanged, so a provider change degrades to "no fix", never to a broken
 * compaction.
 */

import { Plugin } from "@opencode/plugin"

const OPEN_TAG = "<template>"
const CLOSE_TAG = "</template>"

function stripTags(text: string): string {
  return text.replaceAll(OPEN_TAG, "").replaceAll(CLOSE_TAG, "")
}

/** Remove the wrapper tags from a provider body. Handles SSE streams and plain JSON. */
export function stripWrapperTags(body: string): string {
  const lines = body.split("\n")
  const raw: string[] = []
  const parsed: ({ obj: unknown } | null)[] = []
  const refs: { content: string }[] = []
  let sawData = false

  for (const line of lines) {
    if (!line.startsWith("data:")) {
      parsed.push(null)
      raw.push(line)
      continue
    }
    sawData = true
    const payload = line.slice(5).trim()
    if (!payload || payload === "[DONE]") {
      parsed.push(null)
      raw.push(line)
      continue
    }

    let obj: unknown
    try {
      obj = JSON.parse(payload)
    } catch {
      parsed.push(null)
      raw.push(line)
      continue
    }

    const choices = (obj as { choices?: unknown }).choices
    if (Array.isArray(choices)) {
      for (const choice of choices as { delta?: unknown; message?: unknown }[]) {
        for (const holder of [choice?.delta, choice?.message]) {
          const content = (holder as { content?: unknown } | undefined)?.content
          if (typeof content === "string" && content.length > 0) {
            refs.push(holder as { content: string })
          }
        }
      }
    }
    parsed.push({ obj })
    raw.push("")
  }

  // Not a stream: strip the whole body once.
  if (refs.length === 0) return sawData ? body : stripTags(body)

  const joined = refs.map((ref) => ref.content).join("")
  if (!joined.includes(OPEN_TAG) && !joined.includes(CLOSE_TAG)) return body

  const cleaned = stripTags(joined)
  refs.forEach((ref, index) => {
    ref.content = index === 0 ? cleaned : ""
  })
  return parsed.map((entry, index) => (entry ? "data: " + JSON.stringify(entry.obj) : raw[index])).join("\n")
}

export default Plugin.define({
  id: "compaction-clean",

  async setup(ctx) {
    const responseHook = await ctx.session.hook("http.response", async (input) => {
      if (input.kind !== "compaction") return

      const original = input.response

      // Read a copy. The original body stays intact when there is nothing to strip.
      let body: string
      try {
        body = await original.clone().text()
      } catch {
        return
      }

      const cleaned = stripWrapperTags(body)
      if (cleaned === body) return

      const headers = new Headers(original.headers)
      headers.delete("content-length")

      input.response = new Response(cleaned, {
        status: original.status,
        statusText: original.statusText,
        headers,
      })
    })

    return async () => {
      await responseHook.dispose()
    }
  },
})
