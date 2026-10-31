# Cesure background source

This is a direct Canvas 2D port of `makeNoise()` and `initParticleField()` from [Solus-QE/cesure](https://github.com/Solus-QE/cesure/blob/fc8c8b638fd9fc1dcf2f59c981aa3c76258389a5/js/main.js), inspected in the local repository `/home/solus/Documents/Repositories/cesure`.

Source revision: `fc8c8b638fd9fc1dcf2f59c981aa3c76258389a5`. The original `makeNoise()` excerpt has SHA-256 `addbab44af90dfadf68e6097c0b94eae1c720453b11706c3aad1c78114a81351`.

The port preserves the seeded permutation noise, de Jong coefficient functions and recurrence, clustered wisp spawning, flow-field angles, line width, and accumulating paper wash. Counterwhorl replaces scroll progress with a slowly interpolated decorative mission-phase value. It uses warm graphite on the existing dark instrument surface, at low opacity.

`CesureBackground` accepts a canvas and optional paper, ink, and intensity values. It draws at most 24 frames per second, 1,600 attractor samples per frame, and 180 wisps (96 on narrow stages). Backing-store resolution is capped. Reduced motion settles the original static attractor once. Hidden tabs pause, and disposal removes frames, observers, and listeners. Page-cache restores resume the same component.

No cubes, cursor effects, scrolling system, or reveal animations were copied. The background has no access to mission commands, Terse, Relay, or telemetry generation.
