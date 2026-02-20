import * as React from "react";

import { cn } from "../../lib/utils.js";

const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select ref={ref} className={cn("ui-select", className)} {...props}>
      {children}
    </select>
  )
);
Select.displayName = "Select";

export { Select };
