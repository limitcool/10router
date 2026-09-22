"use client";

import PropTypes from "prop-types";

/**
 * Native HTML5 drag wrapper for provider cards. Shared by the dashboard
 * providers page and the media-providers listing pages so every surface drags
 * identically. The parent owns the state (dragging id / over id) and the
 * reorder + persist logic (shared/utils/providerCardOrder.js).
 */
export default function DraggableCard({
  cardId,
  isDragging,
  isOver,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  children,
}) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        onDragStart?.(cardId);
        e.dataTransfer.effectAllowed = "move";
        try {
          e.dataTransfer.setData("text/plain", cardId);
        } catch {}
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOver?.(cardId);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop?.(cardId);
      }}
      onDragEnd={onDragEnd}
      className={`min-w-0 transition-all rounded-xl cursor-grab active:cursor-grabbing ${
        isDragging ? "opacity-30 scale-[0.98]" : isOver ? "ring-2 ring-primary/60 scale-[1.01]" : ""
      }`}
    >
      {children}
    </div>
  );
}

DraggableCard.propTypes = {
  cardId: PropTypes.string.isRequired,
  isDragging: PropTypes.bool,
  isOver: PropTypes.bool,
  onDragStart: PropTypes.func,
  onDragOver: PropTypes.func,
  onDrop: PropTypes.func,
  onDragEnd: PropTypes.func,
  children: PropTypes.node,
};
