// Release builds on Windows must not open a console behind the window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    weblander_lib::run()
}
