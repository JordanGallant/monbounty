// Intentionally vulnerable demo target for the monbounty bounty.
// This is the "planted clue" a hunter finds and a company agent verifies by
// forking THIS repo, running this server, and replaying the PoC against it.
// Dependency-free (Bun.serve) so it runs from a fresh clone with no install.
const users = {
  1: { id: 1, name: "alice", email: "alice@acme.test", apiSecret: "sk_live_alice_PUBLIC_OK" },
  2: { id: 2, name: "bob",   email: "bob@acme.test",   apiSecret: "sk_live_bob_LEAKED_2f9a" },
  3: { id: 3, name: "carol", email: "carol@acme.test", apiSecret: "sk_live_carol_LEAKED_7c1d" },
};
const port = process.env.PORT || 3000;
Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response("monbounty demo target: ok");
    // BUG (IDOR / broken access control): returns any user's full record,
    // including apiSecret, for an arbitrary id, with NO authorization check.
    const m = url.pathname.match(/^\/api\/users\/(\d+)$/);
    if (m) return Response.json(users[m[1]] ?? { error: "not found" });
    return new Response("not found", { status: 404 });
  },
});
console.log(`demo target listening on :${port}`);
