//! What a signed document lets the user change (ADR-121 section 1).
//!
//! [`lock_of`] derives the [`SignatureLock`] from the field scan of the file: a certification signature gives its DocMDP level, approval
//! signatures alone give `fillAndSign`, no signature gives `none`. [`check`] answers whether a [`DocCommand`] fits under a lock; the
//! gate in `AppState::apply_command` refuses the rest with `read_only` (`what: "signed"`).

use super::command::DocCommand;
use crate::error::AppError;
use crate::pdfsig::types::{SigScan, SignatureLock};

/// The lock a document gets from what its signatures claim. A DocMDP entry in the catalog counts even when no signed field is found
/// (a hostile or damaged file is locked, not trusted). A document timestamp is a signature too.
pub fn lock_of(scan: &SigScan) -> SignatureLock {
    if scan.doc_mdp.is_some() {
        return SignatureLock::from_doc_mdp(scan.doc_mdp);
    }
    if scan.fields.iter().any(|field| field.signed) {
        // An approval signature may carry its own DocMDP reference (a certifying signature not named in `/Perms`): the strictest wins.
        let strictest = scan.fields.iter().filter_map(|field| field.cert_p).min();
        return SignatureLock::from_doc_mdp(strictest);
    }
    SignatureLock::None
}

/// What a command touches, by DocMDP class.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Class {
    FormFill,
    Annotation,
    Other,
}

fn class_of(command: &DocCommand) -> Class {
    match command {
        DocCommand::SetFieldValue { .. } | DocCommand::RestoreFields { .. } => Class::FormFill,
        DocCommand::CreateAnnotation { .. }
        | DocCommand::UpdateAnnotation { .. }
        | DocCommand::DeleteAnnotations { .. }
        | DocCommand::MoveAnnotations { .. }
        | DocCommand::Restore { .. } => Class::Annotation,
        DocCommand::Batch { commands, .. } => commands
            .iter()
            .map(class_of)
            .max()
            .unwrap_or(Class::FormFill),
        _ => Class::Other,
    }
}

/// `Ok` when `command` is allowed under `lock`: `none` allows everything, `fillAndSign` form fill, `annotateFillAndSign` form fill and
/// annotations, `locked` nothing. Page, content, redaction, protection, metadata and bibliography commands are never allowed on a
/// signed document. A batch is judged by its strictest command.
pub fn check(lock: SignatureLock, command: &DocCommand) -> Result<(), AppError> {
    let allowed = match lock {
        SignatureLock::None => true,
        SignatureLock::FillAndSign => class_of(command) == Class::FormFill,
        SignatureLock::AnnotateFillAndSign => class_of(command) <= Class::Annotation,
        SignatureLock::Locked => false,
    };
    if allowed {
        Ok(())
    } else {
        Err(AppError::read_only("signed"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::model::form::{FieldId, FieldValue};
    use crate::pdfsig::types::SigField;

    fn fill() -> DocCommand {
        DocCommand::SetFieldValue {
            field: FieldId::new(0),
            value: FieldValue::Checked { on: true },
            coalesce: None,
        }
    }

    fn pages() -> DocCommand {
        DocCommand::DeletePages { pages: Vec::new() }
    }

    fn annotate() -> DocCommand {
        DocCommand::DeleteAnnotations { ids: Vec::new() }
    }

    fn signed(cert_p: Option<u8>) -> SigField {
        SigField {
            signed: true,
            cert_p,
            ..SigField::default()
        }
    }

    #[test]
    fn the_lock_follows_the_file() {
        assert_eq!(lock_of(&SigScan::default()), SignatureLock::None);
        let unsigned = SigScan {
            fields: vec![SigField::default()],
            ..SigScan::default()
        };
        assert_eq!(lock_of(&unsigned), SignatureLock::None);
        let approval = SigScan {
            fields: vec![signed(None)],
            ..SigScan::default()
        };
        assert_eq!(lock_of(&approval), SignatureLock::FillAndSign);
        for (p, lock) in [
            (1, SignatureLock::Locked),
            (2, SignatureLock::FillAndSign),
            (3, SignatureLock::AnnotateFillAndSign),
        ] {
            let certified = SigScan {
                fields: vec![signed(Some(p))],
                doc_mdp: Some(p),
                ..SigScan::default()
            };
            assert_eq!(lock_of(&certified), lock);
        }
        let orphan = SigScan {
            doc_mdp: Some(1),
            ..SigScan::default()
        };
        assert_eq!(lock_of(&orphan), SignatureLock::Locked);
    }

    #[test]
    fn each_lock_allows_its_classes_only() {
        let batch = |commands| DocCommand::Batch {
            label: "x".into(),
            commands,
        };
        let cases: [(SignatureLock, [bool; 3]); 4] = [
            (SignatureLock::None, [true, true, true]),
            (SignatureLock::FillAndSign, [true, false, false]),
            (SignatureLock::AnnotateFillAndSign, [true, true, false]),
            (SignatureLock::Locked, [false, false, false]),
        ];
        for (lock, [form, annotation, page]) in cases {
            assert_eq!(check(lock, &fill()).is_ok(), form, "{lock:?} fill");
            assert_eq!(
                check(lock, &annotate()).is_ok(),
                annotation,
                "{lock:?} annotate"
            );
            assert_eq!(check(lock, &pages()).is_ok(), page, "{lock:?} pages");
            // One forbidden command in a batch refuses the batch.
            assert_eq!(
                check(lock, &batch(vec![fill(), pages()])).is_ok(),
                page,
                "{lock:?} batch"
            );
        }
        assert_eq!(
            check(SignatureLock::Locked, &fill()).unwrap_err().code(),
            ErrorCode::ReadOnly
        );
    }
}
