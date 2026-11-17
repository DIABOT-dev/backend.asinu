# Vietnam administrative address catalog

Retrieved on 2026-11-17. Contains 34 provinces/municipalities and 3,321 wards/communes/special administrative zones. There is no district level. Codes are strings so leading zeroes are preserved.

Province names are taken from the current National Statistics Office catalog: https://danhmuchanhchinh.nso.gov.vn/TongHop.aspx

Ward names, codes and province membership are adapted from Địa Chỉ Việt, published 2026-11-05, effective through 2026-09-20: https://diachiviet.com/du-lieu-mo/ and https://diachiviet.com/api/v1/xa.json . Licensed CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Attribution is also displayed in the address editor. Province labels for codes 22, 24 and 75 use the current official city names rather than the older province labels in the open-data province file.

All province/ward codes and parent relationships were cross-checked against https://provinces.open-api.vn/api/v2/?depth=2 . Ward labels retain the Địa Chỉ Việt source spelling and status. No source-library software is included.

The app and backend bundle the same JSON snapshot. Update both copies together after checking the sources; preserve codes, verify unique ward codes and validate each ward belongs to its province. Runtime address selection makes no requests to the data providers and sends them no user address.
