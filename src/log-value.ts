/**
 * A value from outside, made safe to stand inside ONE line of this server's stderr (SHAT-4307).
 *
 * stderr is read line by line — the host's log viewer, `grep`, a collector that ships one record per
 * line. A value interpolated as is (a purchase id from the model, a parser message quoting the
 * client's frame, an exception chain written by fetch or the API) could carry a newline, and the text
 * after it read as a line this server never wrote.
 *
 * So the value is JSON-encoded — quoted, with \n, \r and the C0 controls escaped, and decodable back
 * exactly by JSON.parse — and then the characters JSON.stringify leaves RAW are escaped too:
 * DEL and the C1 controls (U+007F–U+009F, including NEL U+0085), the line and paragraph separators
 * U+2028/U+2029, and the bidi marks and overrides that reorder what a reader sees. Measured before
 * this was written: JSON.stringify("a\u2028b\u2029c\u0085d\u007fe\u202ef") keeps all five raw.
 *
 * This is ESCAPING, not redaction: the operator still reads the whole value. What must not reach a
 * log at all (a card) is decided elsewhere and is not this function's job.
 */
const LEFT_RAW_BY_JSON = /[\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g

export function forLog(value: unknown): string {
  return JSON.stringify(String(value)).replace(
    LEFT_RAW_BY_JSON,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  )
}
