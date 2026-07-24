/**
 * AddProjectMenu — the compact menu that opens from the Workspace "+" button.
 *
 * Two actions:
 *   1. Open Folder   — route to the existing local directory connect flow.
 *   2. Connect to GitHub — open a small form to clone a public/private repo.
 */
import { useRef, useState } from "react";
import type { JSX } from "react";
import type { FsListResponse } from "../lib/api";
import type { ConnectGitHubRequest } from "../lib/api";
import { AnchoredPopover } from "./AnchoredPopover";
import { ConnectGitHubForm } from "./ConnectGitHubForm";
import { Icon } from "./Icon";

export interface AddProjectMenuProps {
  /** The "+" button element — the menu anchors to it and returns focus on close. */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  open: boolean;
  onDismiss: () => void;
  /** Open the local-folder connect flow. */
  onOpenFolder: () => void;
  /** Called with the API request when the user submits the GitHub form.
   *  Should perform the actual clone + register; resolves with the new path. */
  onConnectGitHub: (req: ConnectGitHubRequest) => Promise<string>;
  /** Called after a successful GitHub connect so the caller can select the
   *  new workspace entry. */
  onAfterConnect: (path: string) => void;
  /** Default parent directory for the clone target-dir suggestion. */
  defaultCloneParent?: string;
  /** Adapter that lists a directory — forwarded to the directory picker inside
   *  ConnectGitHubForm (reserved for future use; not wired today). */
  listDir?: (path?: string) => Promise<FsListResponse>;
}

type MenuView = "menu" | "github-form";

export function AddProjectMenu({
  triggerRef,
  open,
  onDismiss,
  onOpenFolder,
  onConnectGitHub,
  onAfterConnect,
  defaultCloneParent,
}: AddProjectMenuProps): JSX.Element | null {
  const [view, setView] = useState<MenuView>("menu");

  // Reset to menu view when the popover closes.
  const handleDismiss = (): void => {
    setView("menu");
    onDismiss();
  };

  // When the user picks "Open Folder", close the menu and hand off.
  const handleOpenFolder = (): void => {
    handleDismiss();
    onOpenFolder();
  };

  // When the GitHub form succeeds, close the popover and notify the caller.
  const handleGitHubSuccess = (path: string): void => {
    handleDismiss();
    onAfterConnect(path);
  };

  const menuRef = useRef<HTMLDivElement>(null);

  return (
    <AnchoredPopover
      open={open}
      anchorRef={triggerRef}
      onDismiss={handleDismiss}
      placement="down-end"
      className="connect-card add-project-menu"
      testid="add-project-menu"
    >
      {view === "menu" ? (
        <div ref={menuRef} data-testid="add-project-menu-items">
          <div className="connect-card-header">
            <span>Use Existing&hellip;</span>
            <button
              className="theme-toggle connect-card-close"
              onClick={handleDismiss}
              aria-label="Close"
              title="Close"
            >
              <Icon name="X" size={13} />
            </button>
          </div>
          <div className="connect-card-body">
            <button
              type="button"
              className="btn-ghost add-project-menu-item"
              data-testid="add-project-open-folder"
              onClick={handleOpenFolder}
            >
              <Icon name="Folder" size={14} />
              Open Folder
            </button>
            <button
              type="button"
              className="btn-ghost add-project-menu-item"
              data-testid="add-project-connect-github"
              onClick={() => setView("github-form")}
            >
              <Icon name="GitBranch" size={14} />
              Connect to GitHub
            </button>
          </div>
        </div>
      ) : (
        <ConnectGitHubForm
          defaultCloneParent={defaultCloneParent}
          onConnect={onConnectGitHub}
          onSuccess={handleGitHubSuccess}
          onBack={() => setView("menu")}
          onClose={handleDismiss}
        />
      )}
    </AnchoredPopover>
  );
}
