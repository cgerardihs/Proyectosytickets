// Arrastrar y soltar entre listas (tablero y backlog) con HTML5 DnD.
// containers: elementos con [data-drop]; items: [draggable][data-id]
export function sortable(root, { itemSelector = '[data-id]', containerSelector = '[data-drop]', onDrop }) {
  let dragging = null;
  let origin = null;
  let nextSibling = null;

  root.addEventListener('dragstart', (e) => {
    const item = e.target.closest(itemSelector);
    if (!item || !root.contains(item)) return;
    dragging = item;
    origin = item.parentElement;
    nextSibling = item.nextElementSibling;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', item.dataset.id); } catch { /* */ }
  });

  root.addEventListener('dragend', () => {
    if (dragging) dragging.classList.remove('dragging');
    root.querySelectorAll('.drop-over').forEach((c) => c.classList.remove('drop-over'));
    dragging = null;
  });

  root.addEventListener('dragover', (e) => {
    if (!dragging) return;
    const container = e.target.closest(containerSelector);
    if (!container || !root.contains(container)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    root.querySelectorAll('.drop-over').forEach((c) => c !== container && c.classList.remove('drop-over'));
    container.classList.add('drop-over');
    const items = [...container.querySelectorAll(`:scope > ${itemSelector}:not(.dragging)`)];
    const after = items.find((it) => {
      const r = it.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    const empty = container.querySelector(':scope > .drop-empty');
    if (after) container.insertBefore(dragging, after);
    else if (empty) container.insertBefore(dragging, empty);
    else container.appendChild(dragging);
  });

  root.addEventListener('drop', async (e) => {
    if (!dragging) return;
    const container = e.target.closest(containerSelector) || dragging.parentElement;
    e.preventDefault();
    const moved = dragging;
    const ids = [...container.querySelectorAll(`:scope > ${itemSelector}`)].map((x) => Number(x.dataset.id));
    const changedContainer = container !== origin;
    try {
      await onDrop({ id: Number(moved.dataset.id), container, order: ids, changedContainer });
    } catch (err) {
      // revertir
      if (nextSibling && nextSibling.parentElement === origin) origin.insertBefore(moved, nextSibling);
      else origin.appendChild(moved);
      throw err;
    }
  });
}
