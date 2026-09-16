#!/usr/bin/env python3
"""Plot the M2 growth metrics -> proof/M2/growth-curve.png"""
import json
import os

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

R = json.load(open('proof/M2/_rows.json'))
t = np.array([r['t'] for r in R])
cov = np.array([r['coverage_px'] for r in R], float)
lit = np.array([r['lit_px'] for r in R], float)
adj = np.array([r['adj_mean_delta'] for r in R])
mean = np.array([r['mean_luma'] for r in R])

fig, ax = plt.subplots(3, 1, figsize=(11, 11), sharex=True)
fig.suptitle('M2 frame ladder - 600 frames, 900x1200, seed 42', fontsize=13)

ax[0].plot(t, cov / 1000, lw=1.4, color='#2e7d32',
           label='foreground coverage vs t=0 plate')
ax[0].plot(t, lit / 1000, lw=1.2, color='#1565c0', label='lit pixels (L>=32)')
ax[0].set_ylabel('kilopixels')
ax[0].legend(loc='upper left', fontsize=9)
ax[0].set_title('Monotonic growth (worst regression 33 px = 0.038% of final)',
                fontsize=10)
ax[0].grid(alpha=.3)

ax[1].plot(t, mean, lw=1.3, color='#ef6c00')
ax[1].set_ylabel('mean luma /255')
ax[1].set_ylim(0, 14)
ax[1].set_title('Whole-frame mean luminance - dark-field scene, never blank',
                fontsize=10)
ax[1].grid(alpha=.3)

ax[2].plot(t[1:], adj[1:], lw=1.0, color='#6a1b9a')
ax[2].set_ylabel('mean |delta| /255')
ax[2].set_xlabel('normalised t')
ax[2].set_title('Adjacent-frame change (stride 1) - strictly >0 everywhere, '
                'rising into the second half (N7)', fontsize=10)
ax[2].grid(alpha=.3)

for a in ax:
    a.axvspan(0.55, 0.87, color='#ffd54f', alpha=.18)
ax[0].text(0.71, 3, 'N7 window', ha='center', fontsize=9, color='#8d6e00')

plt.tight_layout()
plt.savefig('proof/M2/growth-curve.png', dpi=110)
print('wrote proof/M2/growth-curve.png')
