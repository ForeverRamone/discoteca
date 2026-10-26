// Arrastrar y soltar con SortableJS (se carga solo cuando hace falta).
let sortableModule;

export async function enableReorder(container) {
  sortableModule ??= import('/vendor/sortable.js').then((m) => m.default);
  const Sortable = await sortableModule;
  return Sortable.create(container, {
    animation: 160,
    // En pantallas táctiles hay que mantener pulsado un momento: así deslizar sigue sirviendo para desplazarse.
    delay: 180,
    delayOnTouchOnly: true,
    touchStartThreshold: 6,
    // Arrastre con eventos de puntero en vez del «drag & drop» nativo: igual con ratón y con dedo.
    forceFallback: true,
    fallbackTolerance: 3,
    ghostClass: 'drag-ghost',
    chosenClass: 'drag-chosen',
    scroll: true,
    bubbleScroll: true,
  });
}
