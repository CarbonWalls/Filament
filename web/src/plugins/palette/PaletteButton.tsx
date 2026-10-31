import { Icon } from "../../icons";
import Palette, { openPalette } from "./Palette";

/**
 * The palette's own affordance in the top bar — a chrome-slot plugin.
 * It also mounts the overlay itself, so the palette exists only when its
 * plugin is loaded (there is no palette code in the shell).
 */
export default function PaletteButton(props: { workspace: any }) {
  return (
    <>
      <button class="icon-btn" title="Command palette (Ctrl/Cmd+K)" aria-label="Command palette" onClick={openPalette}>
        <Icon name="search" />
      </button>
      <Palette workspace={props.workspace} />
    </>
  );
}
