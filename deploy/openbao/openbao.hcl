# Production configuration for the dedicated key service on the CRM VPS.
# The CA private key and Shamir shares must never be copied to this machine.
ui = false
api_addr = "https://103.173.227.247:8200"
cluster_addr = "https://127.0.0.1:8201"
default_lease_ttl = "15m"
max_lease_ttl = "1h"

storage "raft" {
  path = "/var/lib/openbao"
  node_id = "asinu-openbao-crm-103"
}

listener "tcp" {
  address = "0.0.0.0:8200"
  cluster_address = "127.0.0.1:8201"
  tls_cert_file = "/etc/openbao/tls/server.crt"
  tls_key_file = "/etc/openbao/tls/server.key"
  tls_client_ca_file = "/etc/openbao/tls/ca.crt"
  tls_require_and_verify_client_cert = true
  tls_min_version = "tls13"
  max_request_size = 1048576
}

audit "file" "local-file" {
  options {
    file_path = "/var/log/openbao/audit.jsonl"
    mode = "0600"
  }
}

audit "file" "journal" {
  options {
    file_path = "stdout"
  }
}

telemetry {
  disable_hostname = true
}
