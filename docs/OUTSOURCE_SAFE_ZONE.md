# Outsource Safe Zone

## Auth scaffolding status
Backend da san sang endpoints va database. Doi Outsource chi can hoan thien phan verify logic (goi sang server Google/Zalo) de kiem tra token tho tu Mobile gui len.

## Endpoints da scaffold
- POST /api/auth/google
- POST /api/auth/apple
- POST /api/auth/zalo
- POST /api/auth/phone-login

## Payload ky vong (tam thoi)
- Social: {"token":"...","provider_id":"...","email":"optional","phone_number":"optional"}
- Phone login: {"phone_number":"..."}

## Response
Tra ve JSON giong luong email login: {"ok":true,"token":"...","user":{"id":...,"email":"..."}}

## Env vars (noi bo, khong commit secret)
- GOOGLE_IOS_CLIENT_ID
- ZALO_APP_ID
- ZALO_SECRET_KEY
- APPLE (pending)
