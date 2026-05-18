# Layered service

Layers: `api/` → `domain/` → `infra/`. Domain code may not import from `api/`. Use this fixture to exercise boundary inference.
