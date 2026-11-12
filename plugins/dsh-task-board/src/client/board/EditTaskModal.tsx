/**
 * Edit-task modal: title + description + the prompt the next execution will
 * send, pre-filled from the task. Shown only for tasks that have never
 * started executing (the detail view gates on canEditTaskContent); the Host
 * still re-checks at submit, so a task that started running while the modal
 * was open fails closed and the error surfaces here.
 */
import { useState } from 'react'
import type { BoardController } from '../../core/controller.ts'
import { collectKnownTags, type TaskRecord, type TaskTag } from '../../core/tasks.ts'
import { canEditTaskContent } from '../../core/use-cases/task-update.ts'
import { t } from '../locales.ts'
import { CollapsibleSection, ModalShell, TargetDateField, TaskContentFields, TaskFormLayout, TaskTagFields, cleanTags } from './TaskForm.tsx'
import { AttachmentField, type AttachmentSelection } from './AttachmentField.tsx'
import { dedupeAttachments, type TaskAttachment } from '../../core/attachment.ts'
import type { OverlayPhase } from './overlay.tsx'
import css from '../board.module.css'
import { resolveProjectId } from '../../core/planning.ts'
import { ProjectField } from './project-view.tsx'

/** Edit-task form overlay. */
export function EditTaskModal({ controller, task, onClose, phase }: { controller: BoardController; task: TaskRecord; onClose: () => void; phase?: OverlayPhase }) {
  const [original] = useState(task)
  const [title, setTitle] = useState(task.title)
  const [targetDate, setTargetDate] = useState(task.targetDate ?? '')
  const [description, setDescription] = useState(task.description)
  const [prompt, setPrompt] = useState(task.prompt)
  const [tags, setTags] = useState<TaskTag[]>(task.tags ?? [])
  const [projectId, setProjectId] = useState<string | null>(resolveProjectId(task) ?? null)
  // The card's attachments: the stored ones the user kept, plus the files
  // staged locally. A staged file is uploaded when the card is SAVED.
  const [attachments, setAttachments] = useState<AttachmentSelection>({
    persisted: task.attachments ?? [],
    staged: [],
  })
  const [attachmentError, setAttachmentError] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)

  const blocked = !canEditTaskContent(task)
  const snapshot = controller.getSnapshot()
  const tagList = cleanTags(tags)
  const originalTags = original.tags ?? []
  const tagsChanged = tagList.length !== originalTags.length || tagList.some((tag, index) =>
    tag.name !== originalTags[index]?.name || tag.promptPrefix !== originalTags[index]?.promptPrefix)

  const submit = async (): Promise<void> => {
    if (pending || blocked) return
    if (title.trim() === '') {
      setError(t('new.required'))
      return
    }
    setPending(true)
    // The staged files are uploaded when the card is saved, never when they
    // are picked: an abandoned edit leaves no stored object behind.
    const uploaded: TaskAttachment[] = []
    for (const staged of attachments.staged) {
      setAttachments(current => markStaged(current, staged.id, { pending: true, error: undefined }))
      try {
        const attachment = await controller.uploadAttachment(staged.file, staged.kind)
        if (attachment === undefined) throw new Error(t('new.attachments.unavailable'))
        uploaded.push(attachment)
      } catch (uploadError) {
        const message = uploadError instanceof Error ? uploadError.message : String(uploadError)
        setAttachments(current => markStaged(current, staged.id, { pending: false, error: message }))
        setPending(false)
        setError(message)
        return
      }
    }
    const carried = dedupeAttachments([...attachments.persisted, ...uploaded])
    // The attachments ride the patch ONLY when the resulting ordered set
    // differs from the card's current one: a title-only edit must not make
    // the Host re-read and re-verify the stored objects, and it must still
    // work in a deployment whose attachment storage is unavailable.
    const current = original.attachments ?? []
    const unchanged = current.length === carried.length
      && current.every((attachment, index) => attachment.attachmentId === carried[index]?.attachmentId)
    const patch = {
      ...(title.trim() === original.title ? {} : { title }),
      ...(description.trim() === original.description ? {} : { description }),
      ...(prompt.trim() === original.prompt ? {} : { prompt }),
      ...(projectId === (resolveProjectId(original) ?? null) ? {} : { projectId }),
      ...(targetDate === (original.targetDate ?? '') ? {} : { targetDate: targetDate || null }),
      ...(tagsChanged ? { tags: tagList.length > 0 ? tagList : null } : {}),
      // An array REPLACES the stored set; an explicit null clears it. A card
      // whose set did not change sends nothing at all.
      ...(unchanged
        ? {}
        : (carried.length > 0 ? { attachments: carried } : { attachments: null })),
    }
    if (Object.keys(patch).length === 0 || await controller.updateTask(task.id, patch)) {
      onClose()
      return
    }
    setPending(false)
    setError(controller.getSnapshot().transportError ?? t('new.required'))
  }

  return (
    <ModalShell
      ariaLabel={t('edit.title')}
      title={t('edit.title')}
      error={blocked ? t('edit.locked') : error}
      pending={pending}
      blocked={blocked}
      wide
      submitLabel={t('edit.save')}
      onSubmit={() => { void submit() }}
      onClose={onClose}
      phase={phase}
    >
      <TaskFormLayout
        content={
          <TaskContentFields
            title={title}
            description={description}
            prompt={prompt}
            onTitleChange={value => { setTitle(value); setError(undefined) }}
            onDescriptionChange={setDescription}
            onPromptChange={setPrompt}
            renderPrompt={input => (
              <>
                <AttachmentField selection={attachments} onChange={setAttachments}
                  limits={snapshot.host?.attachmentLimits}
                  unavailable={snapshot.host !== undefined && snapshot.host.attachmentLimits === undefined}
                  disabled={pending || blocked} onError={setAttachmentError}>
                  {input}
                </AttachmentField>
                {attachmentError !== undefined && <p className={css.formError} role="alert">{attachmentError}</p>}
              </>
            )}
          />
        }
        settings={<>
          <ProjectField value={projectId} projects={snapshot.executionOptions.workspaces} disabled={pending || blocked}
            onChange={setProjectId} />
          <TargetDateField value={targetDate} disabled={pending || blocked} onChange={setTargetDate} />
          <CollapsibleSection title={t('new.section.labels')} summary={tagList.length === 0
            ? t('new.summary.none') : t('new.summary.labelCount', { count: String(tagList.length) })}>
            <TaskTagFields tags={tags} knownTags={collectKnownTags(snapshot.tasks)} onChange={setTags} />
          </CollapsibleSection>
        </>}
      />
    </ModalShell>
  )
}

/**
 * Mark one staged attachment row: the upload state and the failure reason.
 */
function markStaged(
  selection: AttachmentSelection,
  id: string,
  patch: { pending?: boolean; error?: string },
): AttachmentSelection {
  return {
    ...selection,
    staged: selection.staged.map(staged => staged.id === id ? { ...staged, ...patch } : staged),
  }
}

/** Edit-tags modal: edit labels only, shown for tasks after first execution. */
export function EditTagsModal({ controller, task, onClose, phase }: { controller: BoardController; task: TaskRecord; onClose: () => void; phase?: OverlayPhase }) {
  const [tags, setTags] = useState<TaskTag[]>(task.tags ?? [])
  const [error, setError] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)

  const submit = async (): Promise<void> => {
    setPending(true)
    const tagList = cleanTags(tags)
    const patch = {
      tags: tagList.length > 0 ? tagList : null,
    }
    if (await controller.updateTask(task.id, patch)) {
      onClose()
      return
    }
    setPending(false)
    setError(controller.getSnapshot().transportError ?? t('new.required'))
  }

  return (
    <ModalShell
      ariaLabel={t('detail.editTags')}
      title={t('detail.editTags')}
      error={error}
      pending={pending}
      submitLabel={t('edit.save')}
      onSubmit={() => { void submit() }}
      onClose={onClose}
      phase={phase}
    >
      <TaskTagFields tags={tags} knownTags={collectKnownTags(controller.getSnapshot().tasks)} onChange={setTags} />
    </ModalShell>
  )
}

