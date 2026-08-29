/**
 * LLM-facing purchase request input.
 *
 * `merchant` and `amount` are the ergonomic shape exposed to the agent.
 * They are translated to the backend wire contract (`merchant_ref` +
 * integer `amount_cents`) at the HTTP boundary via `toPurchaseWireBody`.
 */
export interface PurchaseInput {
  publisher_user_id: string
  agent_id: string
  merchant: string
  amount: number
  currency: string
  description: string
  user_hint?: {
    email?: string
    name?: string
    phone?: string
    country?: string
  }
  idempotency_key?: string
}

/** Credential request input */
export interface CredentialInput {
  publisher_user_id: string
  agent_id: string
  merchant_domain: string
  purpose: string
  idempotency_key?: string
}

/**
 * Sandbox authorization simulation input.
 *
 * Maps to the deployed `POST /v1/sandbox/authorizations` policy engine, which
 * is side-effect-free (no ledger, no outbox, no money). `amount` is an integer
 * minor-unit value per the backend `sandboxAuthRequest` struct. The agent must
 * belong to the publisher that owns the sandbox key.
 */
export interface SandboxAuthInput {
  agent_id: string
  amount: number
  currency: string
  // STRING on the wire: the backend's struct is `MCC string` and Go rejects a JSON
  // number into a string field, so a numeric mcc 400'd before the handler ran. The tool
  // schema accepts either spelling and normalises here.
  mcc: string
  merchant_name: string
  card_number: string
}

/** Tool definition for listing */
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

/** Tool handler function */
/**
 * What a long-running tool needs from the transport: a way to say "still going" and a way to know
 * whether anyone is listening.
 *
 * ⚠️ `hasProgressToken` IS NOT A DETAIL. A progress notification only resets the client's request
 * timeout when the CLIENT asked for progress by sending a token (`_meta.progressToken`) and enables
 * `resetTimeoutOnProgress` — both are the host's choice, not ours. Without a token there is nobody to
 * notify and the host's default 60s timeout stands, so a tool must finish inside it rather than
 * assume it has been granted more time. Promising on the host's behalf is the failure this field
 * exists to prevent.
 */
export interface ToolContext {
  readonly hasProgressToken: boolean
  /** Report liveness. A no-op when the client sent no progress token. */
  reportProgress(message: string): Promise<void>
}

/**
 * A tool handler. The second parameter is OPTIONAL so that the eight existing modules, none of which
 * needs it, are untouched (SHAT-2802).
 */
export type ToolHandler = (args: Record<string, unknown>, ctx?: ToolContext) => Promise<ToolCallResult>

/** MCP tool call result — compatible with SDK's CallToolResult */
export interface ToolCallResult {
  [key: string]: unknown
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/** Tool module export shape */
export interface ToolModule {
  tools: ToolDefinition[]
  handlers: Record<string, ToolHandler>
}

/** Helper to create a text tool result */
export function textResult(text: string, isError = false): ToolCallResult {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  }
}

/** Helper to format JSON for tool output */
export function jsonResult(data: unknown, isError = false): ToolCallResult {
  return textResult(JSON.stringify(data, null, 2), isError)
}
