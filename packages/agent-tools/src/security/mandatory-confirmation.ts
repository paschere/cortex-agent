/** These actions cannot be delegated by a mandate or conversation grace. */
export function mandatoryHumanConfirmation(toolId: string): boolean {
  return (
    /^(payments|banking)\.(approve|execute|send|transfer|pay)$/.test(toolId) ||
    /(?:^|\.)(delete|purge|destroy|grant_access|revoke_access|change_role|transfer_ownership)$/.test(
      toolId,
    ) ||
    [
      'trackers.remove',
      'kb.share_space',
      'reports.share',
      'views.share',
      'security.set_action_policy',
      // Mete en la cartera, de una vez, todo lo que dice un extracto.
      'payments.import_bank_statement',
      // Una factura electrónica ante la DIAN (0182): ningún mandato la delega.
      'sales.invoice_emit',
      // Decir «sí se le debe» a un proveedor (0181): siempre una persona.
      'payables.approve',
      // Escribir en el programa contable y cerrar el mes (0192): los libros
      // legales de la empresa; siempre una persona, nunca un mandato.
      'accounting.write_purchase',
      'accounting.write_receipt',
      'accounting.write_supplier_payment',
      'close.close_period',
    ].includes(toolId)
  );
}
