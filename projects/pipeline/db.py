"""
Database connection manager — BigQuery edition.

Reads from the threadbeast_mysql dataset mirrored into BigQuery
(project: threadbeast-warehouse, dataset: threadbeast_mysql).

Exposes the same `get_connection()` / `run_query(conn, sql, params)` surface
that the rest of the pipeline expects, so existing callers and SQL files
keep working unchanged. MySQL-style positional `%s` placeholders are
translated to BigQuery's `@p0, @p1, ...` named parameters on the fly.

Authentication uses Application Default Credentials (ADC). Either:
  - `gcloud auth application-default login`, or
  - set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON path.
"""

from contextlib import contextmanager

from google.cloud import bigquery

import config


_DEFAULT_DATASET = f"{config.BQ_PROJECT}.{config.BQ_DATASET}"


class _BQConnection:
    """Thin shim exposing just the surface run_query needs."""

    def __init__(self):
        self.client = bigquery.Client(project=config.BQ_PROJECT)

    def close(self):
        self.client.close()


@contextmanager
def get_connection():
    """
    Context manager yielding a BigQuery-backed connection object.

    Usage:
        with get_connection() as conn:
            rows = run_query(conn, "SELECT 1 AS one")
            print(rows)
    """
    conn = _BQConnection()
    try:
        yield conn
    finally:
        conn.close()


def _bq_type_for(val):
    if isinstance(val, bool):
        return "BOOL"
    if isinstance(val, int):
        return "INT64"
    if isinstance(val, float):
        return "FLOAT64"
    return "STRING"


def _translate_placeholders(sql, params):
    """Convert MySQL-style `%s` into BigQuery `@pN` and build ScalarQueryParameters.

    Returns (translated_sql, [ScalarQueryParameter, ...]).
    """
    if not params:
        return sql, []

    query_params = []
    out = []
    i = 0
    n = len(sql)
    idx = 0
    param_iter = iter(params)
    while i < n:
        if sql[i] == "%" and i + 1 < n and sql[i + 1] == "s":
            try:
                v = next(param_iter)
            except StopIteration as e:
                raise ValueError(
                    "Not enough parameters supplied for %s placeholders"
                ) from e
            name = f"p{idx}"
            out.append(f"@{name}")
            query_params.append(
                bigquery.ScalarQueryParameter(name, _bq_type_for(v), v)
            )
            idx += 1
            i += 2
        else:
            out.append(sql[i])
            i += 1

    # Guard against too many params supplied (iterator still has items)
    extra = list(param_iter)
    if extra:
        raise ValueError(
            f"Supplied {len(params)} params but only {idx} %s placeholders in SQL"
        )

    return "".join(out), query_params


def run_query(conn, sql, params=None):
    """Execute a query and return results as a list of dicts."""
    sql, query_params = _translate_placeholders(sql, params)

    job_config = bigquery.QueryJobConfig(
        default_dataset=_DEFAULT_DATASET,
        query_parameters=query_params,
    )
    job = conn.client.query(sql, job_config=job_config)
    return [dict(row) for row in job.result()]
