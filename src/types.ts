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
}

/** Sandbox test user input */
export interface SandboxUserInput {
  email?: string
  name?: string
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
export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolCallResult>

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
