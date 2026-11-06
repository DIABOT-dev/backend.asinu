# Append to the existing offline operator ACL using an authorized admin session.
# This adds only schedule configuration for the four production Transit keys.
# Every other key config parameter remains forbidden by this grant.
path "transit/keys/asinu-health/config" {
  capabilities = ["update"]
  required_parameters = ["auto_rotate_period"]
  allowed_parameters = {
    "auto_rotate_period" = []
  }
}

path "transit/keys/asinu-doctor/config" {
  capabilities = ["update"]
  required_parameters = ["auto_rotate_period"]
  allowed_parameters = {
    "auto_rotate_period" = []
  }
}

path "transit/keys/asinu-crm/config" {
  capabilities = ["update"]
  required_parameters = ["auto_rotate_period"]
  allowed_parameters = {
    "auto_rotate_period" = []
  }
}

path "transit/keys/asinu-crm-volume/config" {
  capabilities = ["update"]
  required_parameters = ["auto_rotate_period"]
  allowed_parameters = {
    "auto_rotate_period" = []
  }
}
