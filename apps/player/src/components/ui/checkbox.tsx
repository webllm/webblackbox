import * as React from "react";

import { cn } from "../../lib/utils.js";

const Checkbox = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} type="checkbox" className={cn("ui-checkbox", className)} {...props} />
  )
);
Checkbox.displayName = "Checkbox";

export { Checkbox };
