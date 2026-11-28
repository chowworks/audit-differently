import { BadRequestException, ForbiddenException } from '@nestjs/common'
import { AdminWorkspacesController } from './admin-workspaces.controller'
import { WorkspacesController } from './workspaces.controller'

/** The message of the 400 that `run` throws. */
async function refusal(run: () => unknown): Promise<string> {
  try {
    await run()
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException)
    return ((e as BadRequestException).getResponse() as { message: string }).message
  }
  throw new Error('the body was not refused')
}

/** Both controllers, over a service that must never be reached by a body of the wrong type. */
function controllers() {
  const workspaces = {
    create: jest.fn(),
    rename: jest.fn(),
    get: jest.fn(),
    adminGet: jest.fn(),
    setReadEmailedReceiptsWithAi: jest.fn(),
    setTagTypes: jest.fn(),
    setReceiptsAddress: jest.fn(),
    suggest: jest.fn(),
    addMember: jest.fn(),
    setRole: jest.fn(),
  }
  const callers = {
    load: jest.fn().mockResolvedValue({}),
    loadAdmin: jest.fn().mockResolvedValue({}),
  }
  return {
    owner: new WorkspacesController(workspaces as never, callers as never),
    admin: new AdminWorkspacesController(workspaces as never, callers as never),
    workspaces,
  }
}

describe('workspace request bodies', () => {
  it('answers a suggestion sent as a number with a 400, not a 500', async () => {
    const { owner, workspaces } = controllers()
    expect(await refusal(() => owner.suggest('u', 'w-1', { text: 5 }))).toBe('text must be text')
    expect(workspaces.suggest).not.toHaveBeenCalled()
    // Left out: the service asks for it in plain words ("Say what to add"), as before.
    await owner.suggest('u', 'w-1', null)
    expect(workspaces.suggest).toHaveBeenCalledWith({}, 'w-1', '')
  })

  it("refuses every wrong type of a member in one message, on the owners' and the admin's route", async () => {
    const { owner, admin, workspaces } = controllers()
    const body = { email: 5, displayName: [], role: 3 }
    const message = 'email must be text. displayName must be text. role must be text'
    expect(await refusal(() => owner.addMember('u', 'w-1', body))).toBe(message)
    expect(await refusal(() => admin.addMember('u', 'w-1', body))).toBe(message)
    expect(workspaces.addMember).not.toHaveBeenCalled()
    // As the invite dialog sends it.
    await owner.addMember('u', 'w-1', {
      email: 'sam@example.org',
      displayName: '',
      role: 'bookkeeper',
    })
    expect(workspaces.addMember).toHaveBeenCalledWith({}, 'w-1', {
      email: 'sam@example.org',
      displayName: '',
      role: 'bookkeeper',
    })
  })

  it('refuses a role that is missing or not text, on both routes', async () => {
    const { owner, admin, workspaces } = controllers()
    expect(await refusal(() => owner.setRole('u', 'w-1', 'u-2', null))).toBe('role is required')
    expect(await refusal(() => admin.setRole('u', 'w-1', 'u-2', { role: 5 }))).toBe(
      'role must be text'
    )
    expect(workspaces.setRole).not.toHaveBeenCalled()
    await owner.setRole('u', 'w-1', 'u-2', { role: 'auditor' })
    expect(workspaces.setRole).toHaveBeenCalledWith({}, 'w-1', 'u-2', 'auditor')
  })

  it("refuses a new workspace's owner email or name that is not text", async () => {
    const { owner, workspaces } = controllers()
    expect(
      await refusal(() => owner.create('u', { name: 'Riverbend', ownerEmail: 5, ownerName: {} }))
    ).toBe('ownerEmail must be text. ownerName must be text')
    expect(workspaces.create).not.toHaveBeenCalled()
    await owner.create('u', { name: 'Riverbend', ownerEmail: 'dana@example.org', ownerName: '' })
    expect(workspaces.create).toHaveBeenCalledWith(
      {},
      {
        name: 'Riverbend',
        ownerEmail: 'dana@example.org',
        ownerName: '',
      }
    )
  })

  it('refuses a name that is not text on both rename routes', async () => {
    const { owner, admin, workspaces } = controllers()
    expect(await refusal(() => owner.rename('u', 'w-1', { name: 7 }))).toBe('name must be text')
    expect(await refusal(() => admin.rename('u', 'w-1', [1]))).toBe(
      'The request body must be a JSON object'
    )
    expect(workspaces.rename).not.toHaveBeenCalled()
  })

  it('saves only the lists sent, checks their types, and saves nothing for an empty body', async () => {
    const { owner, admin, workspaces } = controllers()
    // An empty body was a 500 (body.readEmailedReceiptsWithAi); now nothing is saved.
    await owner.setLists('u', 'w-1', null)
    expect(workspaces.setReadEmailedReceiptsWithAi).not.toHaveBeenCalled()
    expect(workspaces.setTagTypes).not.toHaveBeenCalled()
    expect(workspaces.setReceiptsAddress).not.toHaveBeenCalled()
    expect(
      await refusal(() =>
        owner.setLists('u', 'w-1', { readEmailedReceiptsWithAi: 'yes', receiptsAddress: 5 })
      )
    ).toBe('receiptsAddress must be text. readEmailedReceiptsWithAi must be true or false')
    await owner.setLists('u', 'w-1', { readEmailedReceiptsWithAi: true })
    expect(workspaces.setReadEmailedReceiptsWithAi).toHaveBeenCalledWith({}, 'w-1', true)
    // The tag types go to cleanTagTypes as sent.
    await admin.setLists('u', 'w-1', { tagTypes: [{ label: 'Funding source' }] })
    expect(workspaces.setTagTypes).toHaveBeenCalledWith({}, 'w-1', [{ label: 'Funding source' }])
    // The admin still may not set the receipts address.
    await expect(admin.setLists('u', 'w-1', { receiptsAddress: 'riverbend' })).rejects.toThrow(
      ForbiddenException
    )
  })
})
