"""Demo for Terax's execution map — run this under the debugger (F5).

Designed to exercise the graph view properly:
- a deep call chain (main → train → run_epoch → train_step → forward/loss)
  so nodes spread across columns with edges between them
- fan-out (train_step calls several helpers) so columns have multiple rows
- recursion (depth_probe) so you see a dashed back-edge
- hot functions (normalize hit hundreds of times) so edge ×counts show up
- a shrunken final batch (shape change → amber border on the node)
- a NaN injected at step 12 (nonfinite → red border; with a tracepoint at
  capture:"stats" it also shows in find_anomalies)

Works with or without torch. Tips: put a tracepoint (⌥-click the gutter)
on the line AFTER `loss = compute_loss(...)` in train_step, then F5.
"""


import math
import random

try:
    import torch
except ImportError:
    torch = None

BATCH = 32
FEATURES = 16
STEPS_PER_EPOCH = 8
EPOCHS = 3


def make_batch(step, last):
    # Final batch is smaller — watch the amber shape-change border.
    n = BATCH // 2 if last else BATCH
    if torch is not None:
        x = torch.randn(n, FEATURES)
        if step == 12:  # inject a NaN mid-training → red border
            x[0, 0] = float("nan")
        return x
    x = [[random.gauss(0, 1) for _ in range(FEATURES)] for _ in range(n)]
    if step == 12:
        x[0][0] = float("nan")
    return x


def normalize(x):
    if torch is not None:
        return (x - x.mean()) / (x.std() + 1e-6)
    flat = [v for row in x for v in row]
    m = sum(flat) / len(flat)
    s = math.sqrt(sum((v - m) ** 2 for v in flat) / len(flat)) + 1e-6
    return [[(v - m) / s for v in row] for row in x]


def forward(x):
    h = normalize(x)
    if torch is not None:
        return h.tanh().sum(dim=1)
    return [math.tanh(sum(row)) for row in h]


def compute_loss(pred):
    if torch is not None:
        return (pred**2).mean()
    return sum(p * p for p in pred) / len(pred)


def gradient_step(loss, lr=0.01):
    # Stand-in for optimizer.step(); just some traced work.
    return float(loss) * (1 - lr) if torch is None else loss.item() * (1 - lr)


def train_step(step, last):
    x = make_batch(step, last)
    pred = forward(x)
    loss = compute_loss(pred)
    adjusted = gradient_step(loss)
    return adjusted  # ← tracepoint here captures x, pred, loss, adjusted


def run_epoch(epoch, global_step):
    total = 0.0
    for i in range(STEPS_PER_EPOCH):
        last = epoch == EPOCHS - 1 and i == STEPS_PER_EPOCH - 1
        total += train_step(global_step + i, last)
    return total / STEPS_PER_EPOCH, global_step + STEPS_PER_EPOCH


def depth_probe(n):
    # Recursion → dashed back-edge on the map.
    return n if n <= 1 else depth_probe(n - 1) + 1


def train():
    step = 0
    for epoch in range(EPOCHS):
        avg, step = run_epoch(epoch, step)
        print(f"epoch {epoch}: avg loss {avg:.4f}")
    return depth_probe(6)


def main():
    print(f"torch: {'yes' if torch is not None else 'no (pure-python mode)'}")
    depth = train()
    print(f"done (probe depth {depth})")


if __name__ == "__main__":
    main()
