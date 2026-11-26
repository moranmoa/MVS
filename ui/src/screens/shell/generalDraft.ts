// G-51n (docs/ux/specs/server-icon-description.md §1): Settings → General has
// one "Save" for the page. Each section (name, icon and description, age limit)
// keeps its own draft and errors, and the page drives them through this handle.

export interface SectionHandle {
  /** Before anything saves: a confirmation the section needs (G-52's raise and lower). False: nothing is saved. */
  confirm?(): Promise<boolean>;
  /** Saves this section's draft, if any. False when it failed (the section shows why). */
  save(): Promise<boolean>;
  /** Back to the saved values. */
  discard(): void;
}

export interface SectionState {
  dirty: boolean;
  /** The draft can't be saved as it is (an empty name, a description over its limits). */
  invalid: boolean;
}
