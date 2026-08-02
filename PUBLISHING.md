# Publishing `tokenhours-live` to npm

The name `tokenhours-live` is **available** on the npm registry (verified). Once published,
`npx tokenhours-live` works with no `github:` prefix. Do this on Michael's machine (needs his npm login).

## One-time

```bash
cd C:\tokenhours-live          # the repo root (has package.json)

npm login                      # opens a browser; sign in / create an npm account
npm whoami                     # confirm you're logged in

npm test                       # accuracy proof — must print "PASS — 6 checks passed"
npm publish --access public    # first publish (0.2.0). --access public is required for an unscoped package
```

Verify it works from the registry (in a clean shell):

```bash
npx -y tokenhours-live@latest  # should start the meter on http://localhost:4317
npm view tokenhours-live version
```

## After it's live — swap the `github:` form → clean form (one line each)

1. **Site** — `C:\tokenhours\public\index.html`, two blocks marked
   `<!-- SWAP TO: npx tokenhours-live AFTER NPM PUBLISH -->`:
   change `npx github:LeadGenius1/tokenhours-live` → `npx tokenhours-live` in the hero `#hero-cmd`
   and the `#live` `#live-cmd`. Commit + push (auto-deploys).
2. **This README** Quickstart + **repo README** — same swap.
3. **Launch posts** — `C:\tokenhours\docs\LAUNCH-tokenhours-live.md` — same swap, then post.

## Future releases

```bash
npm version patch    # or minor / major — bumps package.json + git tag
git push --follow-tags
npm publish
```

> Until you've run `npm publish`, keep the `npx github:LeadGenius1/tokenhours-live` form everywhere —
> a broken first command permanently loses that user.
