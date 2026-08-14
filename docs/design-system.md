# Cortex — design system

**Direction: soft instrument.**

Cortex is a brain. It listens to calls, reads contracts, remembers what was
promised, and can show you why it believes something. The interface should feel
like a well-made modern instrument — light, rounded, with real depth — not like
the paperwork it replaces.

The people using it are accountants, administrators and warehouse leads who live
inside it all day. Dense enough to be useful, soft enough to sit with for eight
hours.

---

## The four rules

**1. Generous curvature.** `rounded-card` is 14px, `rounded-sm` is 10px, and
controls are `rounded-pill`. Nothing is cut square. If you find a `rounded-[3px]`
or a squared button, it is left over from an earlier direction.

**2. Depth by light, not outline.** Surfaces lift with `shadow-card`; things
that genuinely float (menus, dialogs, the primary button) get `shadow-pop`.
Hairlines stay for edge definition, never as the primary separation. A screen
defined only by lines reads as a spreadsheet.

**3. Data stays monospaced.** Anything a person might check, quote or copy gets
`.tabular` or `font-mono`: plates, waybill numbers, peso figures, timestamps,
ids, counts, durations. Prose stays in the sans face. This is the one austerity
worth keeping — it is legibility, not styling.

**4. Colour carries meaning.**

| Token | Means |
|---|---|
| `primary` (indigo) | The product itself: actions, and anything Cortex asserts |
| `emerald` | In force |
| `amber` | Lapsing — attention, not alarm |
| `rose` | Lapsed, overdue, blocked, irreversible. Never for anything dismissible |
| `sky` | Informational only |
| `ink` / `ink-muted` / `ink-faint` | Text hierarchy |

---

## Type

- **Manrope** (`font-sans`) — UI and prose. A geometric sans with slightly open,
  rounded terminals: it reads as a product, not an admin panel.
- **JetBrains Mono** (`font-mono`) — every piece of evidence. See rule 3.

`.field-label` names the value beneath it — 11px, semibold, gently spaced. It
should recede, not announce itself. Not small caps, and never used as a
decorative eyebrow.

### The scale

Seven steps, each carrying its own line-height. **Use the token, never
`text-[Npx]`.**

| Token | Size | For |
|---|---|---|
| `text-micro` | 11px | Labels, timestamps, evidence. Uppercase ones pair with `tracking-field`. |
| `text-xs` | 12.5px | The workhorse: secondary text, table cells, most chrome. |
| `text-sm` | 13px | Body text, and anything somebody reads a paragraph of. |
| `text-base` | 15px | Emphasis inside a card; the name of the thing you are looking at. |
| `text-lg` | 19px | Section heading. |
| `text-xl` | 22px | Page heading. |
| `text-display` | 32px | One per screen at most, and most screens have none. |

This block did not exist until `tailwind.config.ts` grew a `fontSize` key, and
that single omission is the whole reason the app had **23 arbitrary sizes across
1.849 uses** of `text-[Npx]` while having *not one* raw hex colour. It was never
a discipline problem: colours had tokens and type had nothing to reach for, so
every component invented its own — and the three commonest were 12.5px, 12px and
13px, a difference nobody can see that still had to be decided hundreds of times.

The tokens take Tailwind's own names on purpose. A house scale hiding behind
`text-body-sm` while `text-sm` still resolves to something else is two scales.

---

## The signature: the provenance chip

`<Provenance source readAt detail tone />` from `components/ui/provenance.tsx`.

Apply it wherever the product asserts a fact it did not get from the person
reading it — a SIMIT lookup, a bank balance, a sentence quoted from a call:

```tsx
<Provenance source="SIMIT" readAt="04 ago 10:18" detail="sin multas" />
<Provenance source="RUNT" readAt="04 ago 09:02" detail="RTM vencida" tone="seal" />
```

A soft capsule, not a rubber stamp: the claim is trustworthy, and trustworthy
does not need to shout. **A value with no provenance gets no chip** — an empty
one turns the device into decoration and devalues every real one.

`<Field label>` is its companion for a labelled value.

---

## Motion

Movement should answer a question, never decorate. Transitions are short
(120–200ms) and eased out. Controls may lift a hair on hover — the element comes
to meet the cursor. State changes that matter (a document finishing indexing)
get one restrained transition, once.

`prefers-reduced-motion` is honoured globally in `globals.css`. If you animate
in JavaScript, check it yourself — the CSS rule cannot reach you.

---

## Writing

Spanish (Colombia), tuteo, sentence case. Name things by what people control,
not by how the system is built. An action keeps its name through its whole flow:
the button that says **Importar** produces **Importado**.

Errors say what happened and what to do about it — they do not apologise and are
never vague. An empty screen is an invitation to act: say what goes there and
give the control that puts it there.

Untranslated: **Cortex**, **Brain Knowledge**, and external systems (RUNT, SIMIT,
HubSpot, Google Meet, Linear).

---

## Quality floor

Responsive to mobile. Visible keyboard focus (`:focus-visible` is set globally —
never remove outlines). Reduced motion respected. `ink-faint` is for labels at
11–12px, never body text.
