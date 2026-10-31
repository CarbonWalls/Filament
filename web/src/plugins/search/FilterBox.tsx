import { createSignal } from "solid-js";
import type { WorkspaceApi } from "../../core/types";
import { Icon } from "../../icons";

/** Inline filter for the focused pane (not a global search — that is a view). */
export default function FilterBox(props: { workspace: WorkspaceApi }) {
  const [value, setValue] = createSignal("");
  const pane = () => props.workspace.focused();
  return (
    <div class="search-field">
      <Icon name="filter" size={13} />
      <input
        type="search"
        placeholder="Filter"
        spellcheck={false}
        aria-label="Filter the focused folder"
        value={value()}
        onInput={(e) => {
          setValue(e.currentTarget.value);
          pane()?.setFilter(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            setValue("");
            pane()?.setFilter("");
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
      />
    </div>
  );
}
