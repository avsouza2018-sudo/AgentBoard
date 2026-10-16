# The board — design plan

**Subject.** A task board whose workers are agents. The human who opens this page is not doing
the work; they are watching it, approving it, and intervening when a card is stuck. So the page
has to answer two questions before anything else: *who is holding this card right now*, and
*where is a human the only one who can act*.

## Tokens

**Colour**

| name | hex | job |
|---|---|---|
| `slate` | `#14181d` | the board shell — the workspace, not a background |
| `paper` | `#eef1f4` | card stock. A card is a record, so it is drawn as physical stock |
| `ink` | `#171b20` | text on paper |
| `graphite` | `#737d8b` | secondary text, counts, timestamps |
| `machine` | `#4e8d74` | an agent holds the card (the lease) |
| `gate` | `#b9822f` | a state only a human can move cards out of |
| `refusal` | `#a4483d` | the domain said no — shown on the card that caused it |

Two accents with jobs, no decorative colour. `machine` and `gate` are not status flavour: they
encode who is allowed to act, which is the information this product actually carries.

**Type** — self-hosted, no CDN.

- `BigShoulders` (Regular/Bold): the board name and column headers. Condensed industrial signage;
  a column header is a label over a queue, and this face reads as one.
- `IBM Plex Mono` (Regular/Bold/Italic): everything else. The identifiers in this product are
  machine-generated — task keys, run ids, versions — so mono is the primary voice here, not a
  decoration on small labels.

**Layout**

```
┌──────────────────────────────────────────────────────────────────────┐
│ AgentBoard / Agent Work              atlas · run r-42        ● live  │
├──────────────────────────────────────────────────────────────────────┤
│ TO DO 3         IN PROGRESS 1/2     HUMAN REVIEW 1 ⌂     DONE 2      │
│ ┌───────────┐   ┌───────────┐       ┌───────────┐       ┌─────────┐  │
│ │ AG-1      │   │ AG-2 ▮    │       │ AG-3      │       │ AG-4    │  │
│ │           │   │ held by    │       │           │       │         │  │
│ └───────────┘   └───────────┘       └───────────┘       └─────────┘  │
└──────────────────────────────────────────────────────────────────────┘
   drawer: card detail + append-only activity, opens on the right
```

The hero is the board itself — a live board is the most characteristic thing in this subject's
world, and it is the form the product already has. Nothing above it but identity and the live
connection.

**Principles**

1. Cards are paper on a slate board: hard edges, no shadow, one rule between columns.
2. Colour encodes who may act, never mood.
3. The lease is the only thing that moves on its own. Everything else animates in response to an
   action — a card settling after a move, a refusal appearing where it happened.
4. A refusal is written in the domain's own words and shown on the card that caused it. The client
   never rewrites an error into its own voice.
5. **The UI does not decide legality.** It renders the workflow graph and asks. If the graph or a
   guard says no, the answer comes back as a refusal and the card goes back to where the server
   says it is — not to where the UI guessed it was.
