# Field Ops Planner

Field Ops Planner helps operations teams plan site visits, monitor work orders, and keep technicians aligned.

## Users

- Operations manager
- Field technician

## Data Model

### Work Order

- title
- status
- scheduled date
- priority
- notes optional

### Technician

- name
- email
- active

## Screens

- Dashboard
- Work orders list
- Work order detail
- Technician directory

## User Flows

1. Manager signs in and reviews work orders due this week.
2. Manager creates a new work order and assigns follow-up notes.
3. Team checks technician availability.

## Business Rules

- Only authenticated users can access the dashboard.
- Records should keep created and updated timestamps.
