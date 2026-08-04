# Cortex — design system

**Direction: transit document.**

The product's claim is provenance: every figure carries where it came from and
when it was read. So the interface is built like the paperwork its users already
trust — customs forms, waybills, rubber stamps, ruled ledgers — rather than like
a dashboard. Everything below follows from that.

The people using this are accountants, warehouse leads and administrators who
live inside it all day, checking figures against systems of record. Density and
legibility beat delight. It should feel like the most trustworthy document in
the building.

---

## The four rules

**1. Rules, not shadows.** A form is defined by its lines. Use `border-border`
hairlines and `border-border-strong` for section divisions. `.rule-double` opens
a major section. Elevation (`shadow-pop`) is reserved for things that genuinely
float: menus, dialogs, popovers. Nothing else gets a shadow.

**2. Corners are near-square.** `rounded-card` is 3px. There is no pill. If you
find `rounded-pill`, `rounded-full` (outside avatars and status dots), or
`rounded-[10px]`, it is a leftover — replace it.

**3. Data is monospaced, always.** Anything a person might check, quote or copy
gets `.tabular` or `font-mono`: plates, waybill numbers, peso figures,
timestamps, ids, counts, durations. Prose stays in the sans face. This is not
styling — it is what makes a column scannable and stops a plate being misread.

**4. Colour is meaning.** There is no decorative accent.

| Token | Means |
|---|---|
| `primary` (stamp blue) | The institution: actions, and anything the system itself asserts |
| `emerald` | A document in force |
| `amber` | Lapsing — attention, not alarm |
| `rose` (rubber-stamp red) | Lapsed, overdue, blocked, refused. Never for anything dismissible |
| `ink` / `ink-muted` / `ink-faint` | Text hierarchy |

---

## Type

- **Archivo** (`font-sans`) — UI and prose. A grotesque drawn for signage and
  forms: institutional without being bureaucratic, and it holds at small sizes.
- **IBM Plex Mono** (`font-mono`) — every piece of evidence. See rule 3.

Field labels use `.field-label`: 10px, uppercase, mono, wide tracking. They name
the box their value sits in, the way a printed form does. Do not use them as
decorative eyebrows — a label that labels nothing is noise.

---

## The signature: the provenance stamp

`<Provenance source readAt detail tone />` from `components/ui/provenance.tsx`.

Apply it wherever the product asserts a fact it did not get from the person
reading it — a SIMIT lookup, a bank balance, a sentence quoted from a call:

```tsx
<Provenance source="SIMIT" readAt="04 Aug 10:18" detail="no fines" />
<Provenance source="RUNT" readAt="04 Aug 09:02" detail="RTM lapsed" tone="seal" />
```

**If a value has no provenance to show, it gets no stamp.** An empty one turns
the device into decoration and devalues the real ones. This is the single
element the interface is remembered by; spend the boldness here and keep
everything around it quiet.

`<Field label>` is its companion: a labelled box on a form, value in mono.

---

## Writing

Name things by what people control, not how the system is built. Active voice,
sentence case, no filler. An action keeps its name through the whole flow: the
button that says **Import** produces **Imported**.

Errors say what happened and what to do about it, in the interface's voice —
they do not apologise and are never vague. An empty screen is an invitation to
act, not a mood: say what goes here and give the control that puts it there.

---

## Quality floor

Responsive to mobile. Visible keyboard focus (`:focus-visible` is set globally —
do not remove outlines). Reduced motion respected. Contrast: `ink-faint` is for
labels at 10–12px on white only, never body text.
