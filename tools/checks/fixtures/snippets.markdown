# Snippets

Compiles: the import names a real export.

```ts
import { formatAmount } from "@fixture/ui";

export const label: string = formatAmount(12n);
```

Does not compile: the package exports no `AmountInput`.

```tsx
import { AmountInput } from "@fixture/ui";

export const field = AmountInput;
```

Two snippets may declare the same name, because each one is compiled as its own module.

```typescript
import { formatAmount } from "@fixture/ui";

const label = formatAmount(1n);
const wrong: number = label;
```

Not TypeScript, never compiled:

```bash
echo "left alone"
```
