import { Icon } from "../../icons";

export default function HelpButton() {
  return (
    <button
      class="icon-btn"
      title="Keyboard shortcuts (?)"
      aria-label="Keyboard shortcuts"
      onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "?" }))}
    >
      <Icon name="keyboard" />
    </button>
  );
}
