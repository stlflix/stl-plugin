/**
 * The single-use tickets the platform hands to a collaborator's page (I6). The
 * registry is durable on purpose: the platform has no database of its own, so a
 * restart there must not reopen a 60 s replay window.
 */
export class InvalidTicket extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidTicket";
  }
}

/** The jti was already spent. Nothing distinguishes it from an expired one upstream. */
export class TicketReused extends Error {
  constructor(jti) {
    super(`ticket '${jti}' was already used`);
    this.name = "TicketReused";
    this.jti = jti;
  }
}

export const MAX_JTI_LENGTH = 200;

function assertJti(jti) {
  if (typeof jti !== "string" || jti.trim() === "" || jti.length > MAX_JTI_LENGTH) {
    throw new InvalidTicket(`jti must be a non-empty string of at most ${MAX_JTI_LENGTH} characters`);
  }
  return jti;
}

function assertExpiry(expiresAt) {
  const date = expiresAt instanceof Date ? expiresAt : new Date(expiresAt ?? NaN);
  if (Number.isNaN(date.getTime())) throw new InvalidTicket("expiresAt must be a date or an ISO timestamp");
  return date.toISOString();
}

/**
 * `ON CONFLICT DO NOTHING RETURNING` makes the race the database's problem: two
 * concurrent exchanges of the same ticket, and exactly one gets a row back.
 * Expired rows are swept right after, so the table stays the size of one hour
 * of logins.
 */
export async function consume(pool, jti, expiresAt) {
  assertJti(jti);
  const expiry = assertExpiry(expiresAt);
  const { rows } = await pool.query(
    `INSERT INTO stl_mcp.used_tickets (jti, expires_at) VALUES ($1, $2)
     ON CONFLICT (jti) DO NOTHING RETURNING jti`,
    [jti, expiry],
  );
  await pool.query("DELETE FROM stl_mcp.used_tickets WHERE expires_at < now()");
  if (rows.length === 0) throw new TicketReused(jti);
  return { jti, consumedAt: new Date().toISOString() };
}
