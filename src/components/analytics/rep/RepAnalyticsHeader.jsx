import React from 'react';
import { format, startOfDay } from 'date-fns';
import { Flame, BarChart3, CalendarDays } from 'lucide-react';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

const ranges = [
  { value: 1, label: 'Today' },
  { value: 7, label: '7D' },
  { value: 30, label: '30D' },
  { value: 90, label: '90D' },
  { value: 99999, label: 'All' },
];

export default function RepAnalyticsHeader({ dateDays, selectedDate, onChangeDays, onSelectDate, streak }) {
  const [calendarOpen, setCalendarOpen] = React.useState(false);

  const selectDate = (date) => {
    if (!date) return;
    onSelectDate(date);
    setCalendarOpen(false);
  };

  return (
    <div className="px-3 md:px-6 pt-4 pb-3 max-w-7xl mx-auto">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 md:w-10 md:h-10 rounded-xl bg-gradient-to-br from-white/10 to-white/5 border border-white/10 flex items-center justify-center shrink-0">
            <BarChart3 className="w-4 h-4 md:w-5 md:h-5 text-white" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg md:text-xl font-black text-white tracking-tight leading-tight">Analytics</h1>
            <p className="text-[10px] md:text-xs text-gray-400 font-medium truncate">
              {selectedDate ? format(selectedDate, 'EEEE, MMM d, yyyy') : 'Performance dashboard'}
            </p>
          </div>
          {streak > 0 && (
            <div className="hidden sm:flex items-center gap-1 bg-orange-500/10 border border-orange-500/20 rounded-full px-2.5 py-1 shrink-0">
              <Flame className="w-3 h-3 text-orange-400" />
              <span className="text-[10px] font-black text-orange-300">{streak}d</span>
            </div>
          )}
        </div>

        <div className="w-full sm:w-auto overflow-x-auto no-scrollbar">
          <div
            className="flex w-max min-w-full sm:min-w-0 items-center gap-0.5 bg-white/[0.04] border border-white/[0.06] rounded-lg p-0.5"
            role="group"
            aria-label="Analytics date range"
          >
            {ranges.map((r) => (
              <button
                key={r.value}
                type="button"
                aria-pressed={!selectedDate && dateDays === r.value}
                onClick={() => onChangeDays(r.value)}
                className={`min-h-10 px-2.5 md:px-3 rounded-md text-[10px] md:text-xs font-bold transition-all duration-200 whitespace-nowrap ${
                  !selectedDate && dateDays === r.value
                    ? 'bg-white text-black shadow-lg shadow-white/10'
                    : 'text-gray-400 hover:text-white hover:bg-white/5'
                }`}
              >
                {r.label}
              </button>
            ))}

            <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={selectedDate ? `Selected date ${format(selectedDate, 'MMMM d, yyyy')}` : 'Choose a specific date'}
                  aria-pressed={!!selectedDate}
                  className={`min-h-10 px-2.5 md:px-3 rounded-md text-[10px] md:text-xs font-bold transition-all duration-200 whitespace-nowrap flex items-center gap-1.5 ${
                    selectedDate
                      ? 'bg-yellow-400 text-black shadow-lg shadow-yellow-500/10'
                      : 'text-gray-400 hover:text-white hover:bg-white/5'
                  }`}
                >
                  <CalendarDays className="w-3.5 h-3.5" />
                  {selectedDate ? format(selectedDate, 'MMM d, yyyy') : 'Date'}
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                sideOffset={8}
                collisionPadding={8}
                className="w-auto max-w-[calc(100vw-1rem)] p-0 bg-[#111113] border-white/10 text-white shadow-2xl"
              >
                <Calendar
                  mode="single"
                  selected={selectedDate || undefined}
                  defaultMonth={selectedDate || new Date()}
                  onSelect={selectDate}
                  disabled={{ after: startOfDay(new Date()) }}
                  initialFocus
                  classNames={{
                    day_selected: 'bg-yellow-400 text-black hover:bg-yellow-300 hover:text-black focus:bg-yellow-400 focus:text-black',
                    day_today: 'border border-yellow-400/60 text-yellow-300',
                  }}
                />
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>
    </div>
  );
}
