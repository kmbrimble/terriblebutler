export function Header({ onOpenAdd, onOpenDeduct }: { onOpenAdd: () => void; onOpenDeduct: () => void }) {
  return (
    <header className="bg-rimmy-purple text-white p-4 sticky top-0 z-10 flex justify-between items-center gap-2 border-b border-rimmy-purpleHover">
      <div className="leading-[1] text-rimmy-orange" style={{ fontFamily: "'Lobster Two', cursive" }}>
        <div className="text-[1.2rem]">Terrible</div>
        <div className="text-[1.3rem] -mt-1">Butler</div>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onOpenDeduct}
          data-testid="deduct-open-button"
          className="touch-target w-11 h-11 flex items-center justify-center bg-gray-600 hover:bg-gray-500 text-white rounded font-bold text-2xl"
        >
          -
        </button>
        <button
          type="button"
          onClick={onOpenAdd}
          data-testid="add-open-button"
          className="touch-target w-11 h-11 flex items-center justify-center bg-rimmy-orange hover:bg-rimmy-orangeHover text-white rounded font-bold text-2xl"
        >
          +
        </button>
      </div>
    </header>
  );
}
