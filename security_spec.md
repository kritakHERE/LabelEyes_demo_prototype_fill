# LabelEyes Firestore Security Specification

## 1. Data Invariants
1. User documents (`/users/{userId}`) and all nested subcollections (`profile`, `allergens`, `scans`, `routines`) are strictly owned by `request.auth.uid == userId`.
2. Users cannot escalate their own `role` to `admin` on creation or update; `role` must be `'user'` on self-registration and is immutable for non-admins.
3. All user-scoped writes require verified email (`request.auth.token.email_verified == true`) and validated document IDs (`isValidId`).
4. `createdAt` is immutable and validated against `request.time`.
5. No raw images are ever stored in Firestore; `scans` only accepts structured text/verdict metadata.
6. `/ingredientReports/{reportId}` requires `incoming().userId == request.auth.uid` on create and allows read/delete only by the author or an admin.

## 2. Adversarial Test Matrix ("Dirty Dozen")
1. Unauthenticated read of `/users/userA` -> `PERMISSION_DENIED`
2. Cross-user read of `/users/userA/allergens/a1` as `userB` -> `PERMISSION_DENIED`
3. Unverified email write to `/users/userA` -> `PERMISSION_DENIED`
4. Self-assigning `role: 'admin'` on `/users/userA` create -> `PERMISSION_DENIED`
5. Shadow field (`isPremium: true`) injected into `/users/userA/profile/main` -> `PERMISSION_DENIED`
6. Spoofed `userId: 'userA'` in `/ingredientReports/r1` created by `userB` -> `PERMISSION_DENIED`
7. Oversized `rawName` (>160 chars) in `/ingredientReports/r1` -> `PERMISSION_DENIED`
8. Invalid `severity: 'critical'` in `/users/userA/allergens/a1` -> `PERMISSION_DENIED`
9. Mutating `createdAt` on `/users/userA` update -> `PERMISSION_DENIED`
10. Blank `list` query on `/ingredientReports` by non-owner without `where('userId', '==', uid)` -> `PERMISSION_DENIED`
11. Oversized document ID (`>128` chars or invalid chars) -> `PERMISSION_DENIED`
12. Non-admin updating `/admins/{uid}` -> `PERMISSION_DENIED`
