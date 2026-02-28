export function openDialog(dialog: HTMLDialogElement, autofocus: HTMLElement): Promise<string> {
  return new Promise((resolve) => {
    const onClose = (): void => {
      dialog.removeEventListener("close", onClose);
      resolve(dialog.returnValue || "cancel");
    };

    dialog.addEventListener("close", onClose);

    if (dialog.open) {
      dialog.close("cancel");
    }

    dialog.showModal();
    requestAnimationFrame(() => {
      autofocus.focus();
      if (autofocus instanceof HTMLInputElement) {
        autofocus.select();
      }
    });
  });
}
