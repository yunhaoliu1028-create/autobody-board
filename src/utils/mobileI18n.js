const ES = {
  myWork: 'Mi trabajo',
  work: 'Trabajo',
  chat: 'Chat',
  settings: 'Configuracion',
  signOut: 'Salir',
  cars: 'autos',
  tasks: 'tareas',
  dueSoon: 'vence pronto',
  needsManager: 'requiere gerente',
  active: 'Activo',
  waitingOnParts: 'Esperando piezas',
  waitingOnMe: 'Esperando por mi',
  done: 'Terminado',
  myRos: 'Mis ROs',
  assignedWorkOnly: 'solo trabajo asignado',
  noRos: 'No hay ROs en esta vista.',
  upcoming: 'Proximos',
  inRepair: 'en reparacion',
  parts: 'Piezas',
  due: 'Vence',
  completed: 'Completadas',
  task: 'Tarea',
  noCompletedTask: 'Aun no hay tareas completadas',
  noActiveTask: 'No hay tarea activa asignada',
  quickView: 'Vista rapida',
  notes: 'Notas',
  photos: 'Fotos',
  noNotes: 'No hay notas todavia.',
  noPhotos: 'No hay fotos adjuntas.',
  close: 'Cerrar',
  vehicle: 'Vehiculo',
  status: 'Estado',
  insurance: 'Seguro',
  customer: 'Cliente',
  loading: 'Cargando...',
  start: 'Iniciar',
  working: 'Trabajando',
  complete: 'Completar',
  completeState: 'Completa',
  partsNotOrdered: 'no ordenadas',
}

const STATUS_ES = {
  checked_in: 'Registrado',
  teardown: 'Desmontaje',
  waiting_parts: 'Esperando piezas',
  body_work: 'Carroceria',
  body_complete: 'Carroceria lista',
  paint_prep: 'Prep pintura',
  in_paint: 'En pintura',
  paint_complete: 'Pintura lista',
  reassembly: 'Reensamble',
  sublet: 'Subcontrato',
  detail: 'Detalle/QC',
  ready: 'Listo',
  delivered: 'Entregado',
}

const PARTS_ES = {
  not_ordered: 'No ordenadas',
  ordered: 'Ordenadas',
  partially_received: 'Parcial',
  all_received: 'Recibidas',
}

export function isSpanishLanguage(language) {
  return language === 'spanish' || language === 'es'
}

export function t(language, key, fallback) {
  if (!isSpanishLanguage(language)) return fallback ?? key
  return ES[key] ?? fallback ?? key
}

export function statusLabel(language, status, fallback) {
  if (!isSpanishLanguage(language)) return fallback ?? status
  return STATUS_ES[status] ?? fallback ?? status
}

export function partsLabel(language, status, fallback) {
  if (!isSpanishLanguage(language)) return fallback ?? status
  return PARTS_ES[status] ?? fallback ?? status
}
