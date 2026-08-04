// Shared output formatter module for tools (T3.3).
// Pure render functions used by all new tools. No I/O, no API calls.
// Parameters are typed `any` to keep this module simple and avoid circular type deps.

export function renderDealCard(deal: any): string {
  return [
    `**${deal.name}** (${deal.stage})`,
    `Amount: $${deal.amount?.toLocaleString() ?? 'unknown'} · Close: ${deal.closeDate ?? 'TBD'}`,
    `Owner: ${deal.ownerName ?? deal.ownerId ?? 'unassigned'}`,
    deal.htmlLink ? `[View in HubSpot](${deal.htmlLink})` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function renderContactCard(contact: any): string {
  return [
    `**${[contact.firstName, contact.lastName].filter(Boolean).join(' ')}**`,
    contact.email ? `📧 ${contact.email}` : '',
    contact.jobTitle && contact.company ? `${contact.jobTitle} at ${contact.company}` : '',
    contact.lastContacted ? `Last contacted: ${contact.lastContacted}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function renderActivityList(activities: any[]): string {
  return activities.map((a) => `- **${a.type}** on ${a.date}: ${a.subject}`).join('\n');
}

export function renderPipelineSummary(stages: any[]): string {
  const header = '| Stage | Deals | Total USD | Probability |';
  const divider = '|---|---|---|---|';
  const rows = stages.map(
    (s) =>
      `| ${s.label} | ${s.dealCount} | $${(s.totalAmount ?? 0).toLocaleString()} | ${Math.round((s.probability ?? 0) * 100)}% |`,
  );
  return [header, divider, ...rows].join('\n');
}

export function renderThreadSummary(thread: any): string {
  return `**${thread.subject}** (${thread.messageCount} messages · ${thread.date})\nFrom: ${thread.from} → To: ${thread.to}\n${thread.snippet}`;
}

export function renderCompanyCard(company: any): string {
  return [
    `**${company.name ?? 'Unknown company'}**`,
    company.domain ? `🌐 ${company.domain}` : '',
    company.industry ? `Industry: ${company.industry}` : '',
    company.numEmployees != null ? `Employees: ${company.numEmployees.toLocaleString()}` : '',
    company.country ? `Country: ${company.country}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
