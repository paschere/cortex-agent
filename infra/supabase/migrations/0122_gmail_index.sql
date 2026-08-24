-- El índice de los hilos de Gmail archivados.
--
-- POR QUÉ NO ESTÁ EN LA 0121, QUE ES DONDE LE TOCA. Es la misma razón exacta
-- que dejó fuera de la 0078 su índice gemelo y obligó a escribir la 0081:
-- Postgres se niega a USAR un valor que se añadió a un enum en la misma
-- transacción, y el CLI de Supabase corre una migración por transacción. La
-- 0121 añade 'gmail' a `document_source`; un índice parcial cuyo predicado
-- nombra ese valor no puede vivir a su lado, y ponerlos juntos falla al
-- aplicar con «invalid input value for enum» mientras el typecheck, las
-- pruebas y el build siguen verdes. Eso ya pasó una vez aquí.
--
-- La migración siguiente es el primer sitio donde el valor existe para
-- Postgres, así que éste es ese sitio.
--
-- QUÉ CONSULTA SIRVE: «lo último de mi correo en el cerebro», que es como se
-- lee un espacio personal recién cargado con un año de buzón — decenas de miles
-- de documentos, de los que interesan los veinte más recientes.
create index if not exists kb_documents_gmail_idx
  on public.kb_documents (collection_id, recorded_at desc)
  where source = 'gmail';
