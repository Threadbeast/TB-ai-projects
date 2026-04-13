# Copy this file to config.py. config.py is gitignored.
#
# Authentication uses Application Default Credentials:
#   1. `gcloud auth application-default login`, OR
#   2. set GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
#
# The service account / user needs at minimum the
# `roles/bigquery.dataViewer` + `roles/bigquery.jobUser` roles on the project.

# Google BigQuery
BQ_PROJECT = "threadbeast-warehouse"
BQ_DATASET = "threadbeast_mysql"
