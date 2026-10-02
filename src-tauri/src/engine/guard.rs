//! Guards around PDFium jobs (SECURITY P5, ADR-002 §8): panic containment and deadline tracking.
//!
//! A running PDFium call cannot be interrupted, so a deadline can only be enforced from the outside: the caller stops
//! waiting, and [`Health`] tells later callers that the worker is stuck so they fail fast instead of queueing behind it.
//! A segfault inside PDFium itself stays uncatchable in-process; crash isolation is the engine process of M7 (P6).

use std::any::Any;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Instant;

use crate::error::{AppError, ErrorCode};

/// Runs one job body and turns a panic into `engine_crashed`, so the worker survives it.
pub(super) fn guarded<T>(body: impl FnOnce() -> Result<T, AppError>) -> Result<T, AppError> {
    match catch_unwind(AssertUnwindSafe(body)) {
        Ok(result) => result,
        Err(payload) => Err(AppError::logged(
            ErrorCode::EngineCrashed,
            format!("panic in PDF job: {}", panic_message(payload.as_ref())),
        )),
    }
}

fn panic_message(payload: &(dyn Any + Send)) -> &str {
    if let Some(message) = payload.downcast_ref::<&str>() {
        message
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message
    } else {
        "non-string panic payload"
    }
}

/// What the worker is doing, as far as callers need to know: the point in time at which the caller of the running
/// job gives up. Shared between the worker (writer) and every [`Engine`](super::Engine) handle (readers).
#[derive(Debug, Default)]
pub(super) struct Health {
    running_until: Mutex<Option<Instant>>,
}

impl Health {
    fn lock(&self) -> MutexGuard<'_, Option<Instant>> {
        // A poisoned lock only means a holder panicked; an `Option<Instant>` cannot be left inconsistent.
        self.running_until
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Marks a job as running until `deadline`. The mark clears when the returned guard drops, also on unwind.
    pub(super) fn begin(&self, deadline: Instant) -> Busy<'_> {
        *self.lock() = Some(deadline);
        Busy(self)
    }

    /// `true` if the running job is still going although its caller has already given up. New jobs would only queue
    /// behind it, so the engine refuses them. It recovers by itself when the slow job finally finishes.
    pub(super) fn is_wedged(&self) -> bool {
        self.is_wedged_at(Instant::now())
    }

    fn is_wedged_at(&self, now: Instant) -> bool {
        self.lock().is_some_and(|deadline| now >= deadline)
    }
}

/// Clears the running mark of a [`Health`] when dropped.
pub(super) struct Busy<'a>(&'a Health);

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        *self.0.lock() = None;
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn a_panic_becomes_engine_crashed_without_leaking_the_message() {
        let result: Result<(), AppError> = guarded(|| panic!("boom at C:/secret/plan.pdf"));
        let error = result.unwrap_err();
        assert_eq!(error.code(), ErrorCode::EngineCrashed);
        // The panic text is only in the log detail; the UI error carries code and key alone.
        let ui = serde_json::to_string(&crate::error::UiError::from(error)).unwrap();
        assert!(!ui.contains("secret") && !ui.contains("boom"), "{ui}");
    }

    #[test]
    fn string_and_str_payloads_are_both_recovered() {
        let from_str = guarded::<()>(|| panic!("static"));
        let from_string = guarded::<()>(|| panic!("{}", String::from("formatted")));
        assert!(from_str.unwrap_err().to_string().contains("static"));
        assert!(from_string.unwrap_err().to_string().contains("formatted"));
    }

    #[test]
    fn results_pass_through_unchanged() {
        assert_eq!(guarded(|| Ok(7)).unwrap(), 7);
        let error = guarded::<()>(|| Err(AppError::invalid("page"))).unwrap_err();
        assert_eq!(error.code(), ErrorCode::InvalidArgument);
    }

    #[test]
    fn a_running_job_is_wedged_only_after_its_deadline() {
        let health = Health::default();
        assert!(!health.is_wedged());
        let deadline = Instant::now() + Duration::from_secs(60);
        let busy = health.begin(deadline);
        assert!(!health.is_wedged_at(deadline - Duration::from_millis(1)));
        assert!(health.is_wedged_at(deadline));
        assert!(health.is_wedged_at(deadline + Duration::from_secs(1)));
        drop(busy);
        assert!(!health.is_wedged_at(deadline + Duration::from_secs(1)));
    }

    #[test]
    fn the_running_mark_clears_when_a_job_unwinds() {
        let health = Health::default();
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            let _busy = health.begin(Instant::now());
            panic!("job panicked");
        }));
        assert!(outcome.is_err());
        assert!(!health.is_wedged());
    }
}
